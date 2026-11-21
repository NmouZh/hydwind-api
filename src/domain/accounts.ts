import { randomBytes, scryptSync } from 'node:crypto';
import { getDb, withTransaction } from '../db/database.ts';
import { migrateBiographyOwner } from './biographies.ts';
import { timingSafeEqualString } from './timing-safe.ts';
import { isValidUsername } from './username.ts';

export { isValidUsername, USERNAME_PATTERN } from './username.ts';

/**
 * 账号存储层（SQLite 版）。
 *
 * 业务语义沿用 hydwind-web 的 JSON 实现，只把文件 IO 换成 `node:sqlite`：
 * 账号名进库前先走 normalizeUsername 白名单（字母数字下划线、限长），
 * 所有查询一律用占位符参数，不存在拼接式注入面。
 *
 * schema 映射需要留意：旧角色是 admin/player，SQLite CHECK 是 admin/member；
 * 对外仍返回 player。updatedAt 与 lastLoginAt 都直接读写 v2 的真实列。
 *
 * 账号来源只有一条链路：群内 @机器人 发送「注册」→ 插件调 /api/auth/register
 * → 这里生成账号密码 → 插件私信玩家。站点上不开放自助注册。
 */

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export const ACCOUNT_ROLES = ['admin', 'player'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface Account {
  username: string;
  nickname: string;
  /** 关联的平台身份，目前是 QQ 号，方便群里认人 */
  platform: string;
  platformId: string;
  role: AccountRole;
  /** scrypt 哈希，格式 scrypt$salt$hash */
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

const ACCOUNT_COLUMNS =
  'username, nickname, platform, platform_id, password_hash, role, created_at, last_login_at, updated_at';

type AccountRow = {
  username: string;
  nickname: string;
  platform: string;
  platform_id: string;
  password_hash: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  updated_at: string;
};

const accountRoleOf = (role: string): AccountRole => (role === 'admin' ? 'admin' : 'player');

const toDbRole = (role: AccountRole): 'member' | 'admin' => (role === 'admin' ? 'admin' : 'member');

const accountFromRow = (row: AccountRow): Account => ({
  username: row.username,
  nickname: row.nickname,
  platform: row.platform,
  platformId: row.platform_id,
  role: accountRoleOf(row.role),
  passwordHash: row.password_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // 老库升级后可能残留 '' 哨兵值；DB 层升级已做 NULLIF，这里再兜一次。
  lastLoginAt: row.last_login_at || null,
});

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const verifyHash = (password: string, stored: string): boolean => {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return timingSafeEqualString(actual.toString('hex'), hash);
};

/**
 * 账号不存在时也跑一次 scrypt，让「没这个号」和「密码错」的耗时接近，
 * 免得有人靠响应时间把站内账号一个个试出来。
 */
let dummyHash: string | null = null;
const getDummyHash = (): string => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

/** 密码上限：scrypt 不拒绝长输入，但没必要为一个 10KB 的「密码」耗 CPU。 */
const MAX_PASSWORD_LENGTH = 200;

/** 去掉容易混淆的 0/O/1/l/I，密码留给玩家手抄。 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const generatePassword = (length = 10): string =>
  Array.from(randomBytes(length), (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');

/** 游戏 ID 直接当账号名，只保留字母数字下划线，避免奇怪字符进库和 URL。 */
export const normalizeUsername = (input: unknown): string => {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 16);
};

const normalizePlatform = (input: unknown): string => {
  if (typeof input !== 'string') return 'qq';
  const value = input.trim().toLowerCase();
  return value || 'qq';
};

const normalizePlatformId = (input: unknown): string => {
  if (typeof input === 'string') return input.trim().slice(0, 64);
  if (typeof input === 'number') return String(input);
  return '';
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface RegisterInput {
  /** 游戏 ID，同时作为登录账号 */
  username: unknown;
  /** QQ 号等平台身份，必填，用来做唯一性判断 */
  platformId: unknown;
  platform?: unknown;
  nickname?: unknown;
  /** 不传就自动生成 */
  password?: unknown;
  role?: unknown;
}

export interface RegisteredAccount {
  username: string;
  password: string;
  role: AccountRole;
  created: boolean;
}

/**
 * 注册（或找回）一个账号。
 *
 * 同一个平台身份重复注册时直接重置密码并回给插件，避免玩家换个昵称就注册出一堆账号。
 * 账号更新在 SQLite 事务里完成；事务提交后再迁移传记键，迁移失败不影响注册结果。
 */
export const registerAccount = async (
  input: RegisterInput
): Promise<ValidationResult<RegisteredAccount>> => {
  const username = normalizeUsername(input.username);
  const platform = normalizePlatform(input.platform);
  const platformId = normalizePlatformId(input.platformId);
  const nickname = typeof input.nickname === 'string' ? input.nickname.trim().slice(0, 32) : '';
  const role: AccountRole = (ACCOUNT_ROLES as readonly string[]).includes(String(input.role))
    ? (input.role as AccountRole)
    : 'player';
  const providedPassword =
    typeof input.password === 'string' &&
    input.password.length >= 6 &&
    input.password.length <= MAX_PASSWORD_LENGTH
      ? input.password
      : '';

  if (!platformId) return { ok: false, message: '缺少平台身份（QQ 号）' };
  if (!isValidUsername(username)) {
    return { ok: false, message: '账号名需要 3-16 位，只能包含字母、数字和下划线' };
  }

  const password = providedPassword || generatePassword();
  const passwordHash = hashPassword(password);

  const outcome = withTransaction(
    (): { result: ValidationResult<RegisteredAccount>; previousUsername: string | null } => {
      const db = getDb();
      const now = new Date().toISOString();

      const byPlatform = db
        .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE platform = ? AND platform_id = ?`)
        .get(platform, platformId) as AccountRow | undefined;

      if (byPlatform) {
        // 老账号：账号名以这次提供的游戏 ID 为准，方便玩家换 ID 后仍用同一个 QQ 登录
        const clash = db
          .prepare('SELECT username FROM accounts WHERE username = ? AND username <> ?')
          .get(username, byPlatform.username);

        if (clash) {
          return {
            result: { ok: false, message: `账号名 ${username} 已被其他玩家占用` },
            previousUsername: null,
          };
        }

        const previousUsername = byPlatform.username;
        db.prepare(
          'UPDATE accounts SET username = ?, nickname = ?, password_hash = ?, updated_at = ? WHERE username = ?'
        ).run(
          username,
          nickname || byPlatform.nickname,
          passwordHash,
          now,
          byPlatform.username
        );

        return {
          result: {
            ok: true,
            value: {
              username,
              password,
              role: accountRoleOf(byPlatform.role),
              created: false,
            },
          },
          previousUsername,
        };
      }

      const byName = db.prepare('SELECT username FROM accounts WHERE username = ?').get(username);
      if (byName) {
        return {
          result: { ok: false, message: `账号名 ${username} 已被占用` },
          previousUsername: null,
        };
      }

      db.prepare(
        `INSERT INTO accounts (${ACCOUNT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        username,
        nickname || username,
        platform,
        platformId,
        passwordHash,
        toDbRole(role),
        now,
        null,
        now
      );

      return {
        result: { ok: true, value: { username, password, role, created: true } },
        previousUsername: null,
      };
    }
  );

  // 账号名就是传记键：改名后把旧记录和评论作者信息迁到新名字。
  // 迁移失败不该阻止玩家重新注册，脏数据留待下次登录补建时处理。
  if (outcome.previousUsername && outcome.previousUsername.toLowerCase() !== username.toLowerCase()) {
    await migrateBiographyOwner(outcome.previousUsername, username).catch((error) => {
      console.error('[accounts] 迁移传记键失败', error);
    });
  }

  return outcome.result;
};

export const verifyLogin = async (username: string, password: string): Promise<Account | null> => {
  const name = normalizeUsername(username);
  const db = getDb();
  const row = name
    ? (db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = ?`).get(name) as
        | AccountRow
        | undefined)
    : undefined;

  // 空密码和超长密码不交给 scrypt，但仍然比对一次哈希，耗时和正常失败保持一致
  const candidate =
    password.length > 0 && password.length <= MAX_PASSWORD_LENGTH
      ? password
      : randomBytes(12).toString('hex');
  const matched = verifyHash(candidate, row?.password_hash ?? getDummyHash());

  if (!row || !matched) return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;

  const now = new Date().toISOString();
  db.prepare('UPDATE accounts SET last_login_at = ? WHERE username = ?').run(now, row.username);
  return { ...accountFromRow(row), lastLoginAt: now };
};

export const findAccount = async (username: string): Promise<Account | undefined> => {
  const name = normalizeUsername(username);
  if (!name) return undefined;
  const row = getDb()
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = ?`)
    .get(name) as AccountRow | undefined;
  return row ? accountFromRow(row) : undefined;
};

export const listAccounts = async (): Promise<Omit<Account, 'passwordHash'>[]> => {
  // created_at 相同的账号按插入顺序（rowid）返回，保持旧 JSON 数组的顺序语义。
  const rows = getDb()
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at ASC, rowid ASC`)
    .all() as AccountRow[];

  return rows.map((row) => {
    const { passwordHash: _passwordHash, ...rest } = accountFromRow(row);
    return rest;
  });
};

export const setAccountRole = async (username: string, role: AccountRole): Promise<boolean> => {
  const name = normalizeUsername(username);
  if (!name) return false;
  const result = getDb()
    .prepare('UPDATE accounts SET role = ?, updated_at = ? WHERE username = ?')
    .run(toDbRole(role), new Date().toISOString(), name);
  return Number(result.changes) > 0;
};

export const publicAccount = (account: Account) => ({
  username: account.username,
  nickname: account.nickname,
  role: account.role,
  createdAt: account.createdAt,
  lastLoginAt: account.lastLoginAt,
});