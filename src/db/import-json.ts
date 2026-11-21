import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 旧 JSON 数据的一次性导入。
 *
 * hydwind-web 的 accounts.json / biographies.json / issues.json 结构见旧仓库
 * `src/lib/*.ts`。这里在首次打开数据库时把它们搬进 SQLite，之后以数据库为准；
 * 原 JSON 文件只读，不改也不删。
 *
 * 幂等标记放在 meta.json_import_v1：
 * - 有标记：直接返回。
 * - 无标记但业务表已有数据：说明数据库被别处写过，打 warn、补标记、跳过，
 *   避免把 JSON 再灌一遍导致重复。
 * - 三个 JSON 都不存在：视为没有旧数据，补标记后返回。
 * - JSON 语法错误：抛清晰错误且不写标记，修好后重启还能重试。
 */

const MARKER_KEY = 'json_import_v1';
const MARKER_VALUE = 'done';

/** 除 meta 外的业务表；任意一张非空都视为数据库已有数据。 */
const BUSINESS_TABLES = [
  'accounts',
  'biographies',
  'comments',
  'issues',
  'issue_replies',
] as const;

const ISSUE_CATEGORIES: ReadonlySet<string> = new Set(['bug', 'suggestion', 'other']);
const ISSUE_STATUSES: ReadonlySet<string> = new Set(['pending', 'open', 'rejected', 'done']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 时间字段保留旧值；缺失时用调用方给的兜底（建库时不允许 NULL）。 */
const asTimestamp = (value: unknown, fallback: string): string => {
  const text = asString(value).trim();
  return text || fallback;
};

const readJsonFile = (file: string): unknown | undefined => {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[db] ${path.basename(file)} JSON 解析失败：${reason}`, { cause: error });
  }
};

/**
 * 旧 JSON 与数据库同目录；显式指定 HYDWIND_DB_PATH 时取它的 dirname。
 * `:memory:` 没有目录，回退到 HYDWIND_DATA_DIR（测试与临时库）。
 */
const legacyDataDir = (): string => {
  const dbFile = process.env.HYDWIND_DB_PATH?.trim();
  if (dbFile && dbFile !== ':memory:') return path.dirname(dbFile);

  const dataDir = process.env.HYDWIND_DATA_DIR?.trim();
  return dataDir || path.join(process.cwd(), 'data');
};

const hasMarker = (db: DatabaseSync): boolean =>
  db.prepare('SELECT 1 AS present FROM meta WHERE key = ?').get(MARKER_KEY) !== undefined;

const writeMarker = (db: DatabaseSync): void => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    MARKER_KEY,
    MARKER_VALUE
  );
};

const hasBusinessRows = (db: DatabaseSync): boolean =>
  BUSINESS_TABLES.some(
    (table) => db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() !== undefined
  );

const listField = (value: unknown, key: string): unknown[] => {
  const record = asRecord(value);
  const list = record?.[key];
  return Array.isArray(list) ? list : [];
};

const importAccounts = (db: DatabaseSync, file: unknown, now: string): number => {
  const insert = db.prepare(`
    INSERT INTO accounts
      (username, nickname, platform, platform_id, password_hash, role, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  for (const entry of listField(file, 'accounts')) {
    const record = asRecord(entry);
    if (!record) continue;

    const username = asString(record.username).trim();
    if (!username) continue;

    const createdAt = asTimestamp(record.createdAt, now);
    // 旧数据可能没有 updatedAt；accounts 表也没有旧 updated_at，退回 createdAt。
    const updatedAt = asTimestamp(record.updatedAt, createdAt);
    // 旧数据里 lastLoginAt 允许 null；v2 的列可空，NULL 原样保留。
    const rawLastLoginAt =
      typeof record.lastLoginAt === 'string' ? record.lastLoginAt.trim() : '';
    const lastLoginAt = rawLastLoginAt || null;
    // 旧角色是 admin/player，新 schema 是 admin/member。
    const role = record.role === 'admin' ? 'admin' : 'member';
    const nickname = asString(record.nickname).trim() || username;
    const platform = asString(record.platform).trim() || 'qq';
    const platformId =
      typeof record.platformId === 'number'
        ? String(record.platformId)
        : asString(record.platformId).trim();

    insert.run(
      username,
      nickname,
      platform,
      platformId,
      asString(record.passwordHash),
      role,
      createdAt,
      updatedAt,
      lastLoginAt
    );
    imported += 1;
  }
  return imported;
};

const importBiographies = (
  db: DatabaseSync,
  file: unknown,
  now: string
): { biographies: number; comments: number } => {
  const insertBiography = db.prepare(`
    INSERT INTO biographies (game_id, main_title, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertComment = db.prepare(`
    INSERT INTO comments (id, game_id, author_username, author_game_id, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let biographies = 0;
  let comments = 0;

  for (const entry of listField(file, 'biographies')) {
    const record = asRecord(entry);
    if (!record) continue;

    const gameId = asString(record.gameId).trim();
    if (!gameId || typeof record.mainTitle !== 'string') continue;

    const createdAt = asTimestamp(record.createdAt, now);
    const updatedAt = asTimestamp(record.updatedAt, createdAt);
    insertBiography.run(gameId, record.mainTitle, asString(record.body), createdAt, updatedAt);
    biographies += 1;

    const commentEntries = Array.isArray(record.comments) ? record.comments : [];
    for (const commentEntry of commentEntries) {
      const comment = asRecord(commentEntry);
      if (!comment) continue;

      const id = asString(comment.id).trim();
      const body = comment.body;
      if (!id || typeof body !== 'string') continue;

      const authorGameId = asString(comment.authorGameId) || asString(comment.authorUsername);
      const authorUsername = asString(comment.authorUsername) || authorGameId;
      insertComment.run(
        id,
        gameId,
        authorUsername,
        authorGameId,
        body,
        asTimestamp(comment.createdAt, createdAt)
      );
      comments += 1;
    }
  }

  return { biographies, comments };
};

const importIssues = (
  db: DatabaseSync,
  file: unknown,
  now: string
): { issues: number; replies: number } => {
  const insertIssue = db.prepare(`
    INSERT INTO issues (id, title, body, category, status, author, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReply = db.prepare(`
    INSERT INTO issue_replies (issue_id, author, body, staff, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let issues = 0;
  let replies = 0;

  for (const entry of listField(file, 'issues')) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = record.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;

    const createdAt = asTimestamp(record.createdAt, now);
    const updatedAt = asTimestamp(record.updatedAt, createdAt);
    const category =
      typeof record.category === 'string' && ISSUE_CATEGORIES.has(record.category)
        ? record.category
        : 'other';
    const status =
      typeof record.status === 'string' && ISSUE_STATUSES.has(record.status)
        ? record.status
        : 'pending';
    const author = typeof record.author === 'string' ? record.author : null;

    insertIssue.run(
      id,
      asString(record.title),
      asString(record.body),
      category,
      status,
      author,
      createdAt,
      updatedAt
    );
    issues += 1;

    // 旧回复 id 是 UUID 字符串，新表用 AUTOINCREMENT 整数，无法保留；
    // 按数组顺序写入，author/body/staff/createdAt 原样保留。
    const replyEntries = Array.isArray(record.replies) ? record.replies : [];
    for (const replyEntry of replyEntries) {
      const reply = asRecord(replyEntry);
      if (!reply || typeof reply.body !== 'string') continue;

      insertReply.run(
        id,
        asString(reply.author),
        reply.body,
        reply.staff === true ? 1 : 0,
        asTimestamp(reply.createdAt, updatedAt)
      );
      replies += 1;
    }
  }

  return { issues, replies };
};

/**
 * 把旧 JSON 导入给定连接。调用方负责连接已经建好表。
 *
 * 数据写入和 marker 在同一个 BEGIN IMMEDIATE 事务里：要么全部成功，
 * 要么全部回滚，下次启动还能重试。
 */
export const importLegacyJson = (db: DatabaseSync): void => {
  if (hasMarker(db)) return;

  if (hasBusinessRows(db)) {
    console.warn(
      '[db] 业务表已有数据但缺少 json_import_v1 标记，跳过旧 JSON 导入以避免重复写入'
    );
    writeMarker(db);
    return;
  }

  const dir = legacyDataDir();
  const accountsFile = path.join(dir, 'accounts.json');
  const biographiesFile = path.join(dir, 'biographies.json');
  const issuesFile = path.join(dir, 'issues.json');

  // 先解析完三个文件再开事务：语法错误直接抛出，不留下 marker 和半截数据。
  const accounts = readJsonFile(accountsFile);
  const biographies = readJsonFile(biographiesFile);
  const issues = readJsonFile(issuesFile);

  if (accounts === undefined && biographies === undefined && issues === undefined) {
    console.info(`[db] 未发现旧 JSON 数据（${dir}），写入 ${MARKER_KEY} 标记`);
    writeMarker(db);
    return;
  }

  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const accountCount = importAccounts(db, accounts, now);
    const biographyCounts = importBiographies(db, biographies, now);
    const issueCounts = importIssues(db, issues, now);
    writeMarker(db);
    db.exec('COMMIT');

    console.info(
      `[db] 已从 JSON 导入 accounts=${accountCount} biographies=${biographyCounts.biographies}` +
        ` comments=${biographyCounts.comments} issues=${issueCounts.issues} replies=${issueCounts.replies}`
    );
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误。
    }
    throw error;
  }
};