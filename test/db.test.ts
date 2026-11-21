import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, databasePath, getDb, withTransaction } from '../src/db/database.ts';

const TEMP_PREFIX = path.join(tmpdir(), 'hydwind-db-');

interface TempEnvOptions {
  dataDir?: (dir: string) => string;
  dbPath?: (dir: string) => string;
}

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

const tableColumns = (db: DatabaseSync, table: string): TableColumnInfo[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableColumnInfo[];

/** v1 时代的旧表结构，用于验证 database.ts 的升级迁移。 */
const V1_SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE accounts (
  username TEXT COLLATE NOCASE PRIMARY KEY,
  nickname TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  UNIQUE (platform, platform_id)
) STRICT;

CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, body TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('bug','suggestion','other')),
  status TEXT NOT NULL CHECK (status IN ('pending','open','rejected','done')),
  author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE issue_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  body TEXT NOT NULL, staff INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  username TEXT COLLATE NOCASE NOT NULL,
  kaomoji TEXT NOT NULL UNIQUE,
  ascii TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
`;

/**
 * 每个用例独立临时目录；打开连接前设置环境，结束后关闭连接、删目录、
 * 还原环境变量。node:test 默认同一文件内串行，不会有两个用例共用数据库。
 */
const withTempEnv = (run: (dir: string) => void, options: TempEnvOptions = {}): void => {
  const dir = mkdtempSync(TEMP_PREFIX);
  const savedDataDir = process.env.HYDWIND_DATA_DIR;
  const savedDbPath = process.env.HYDWIND_DB_PATH;

  process.env.HYDWIND_DATA_DIR = options.dataDir?.(dir) ?? dir;
  const dbPath = options.dbPath?.(dir);
  if (dbPath === undefined) delete process.env.HYDWIND_DB_PATH;
  else process.env.HYDWIND_DB_PATH = dbPath;

  try {
    run(dir);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });

    if (savedDataDir === undefined) delete process.env.HYDWIND_DATA_DIR;
    else process.env.HYDWIND_DATA_DIR = savedDataDir;

    if (savedDbPath === undefined) delete process.env.HYDWIND_DB_PATH;
    else process.env.HYDWIND_DB_PATH = savedDbPath;
  }
};

const setMeta = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
};

const metaValue = (db: DatabaseSync, key: string): string | undefined => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as {
    value: string;
  } | undefined;
  return row?.value;
};

test('getDb 建表并启用 WAL、外键与 busy_timeout', () => {
  withTempEnv((dir) => {
    const db = getDb();
    const dbFile = path.join(dir, 'hydwind.sqlite');

    assert.equal(databasePath(), dbFile);
    assert.ok(existsSync(dbFile));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as { name: string }[];
    const tableNames = new Set(tables.map((row) => row.name));
    for (const name of [
      'meta',
      'accounts',
      'biographies',
      'comments',
      'issues',
      'issue_replies',
      'login_codes',
      'upstream_cache',
    ]) {
      assert.ok(tableNames.has(name), `缺少表 ${name}`);
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as unknown as { name: string }[];
    const indexNames = new Set(indexes.map((row) => row.name));
    for (const name of [
      'idx_comments_game_id',
      'idx_issue_replies_issue_id',
      'idx_login_codes_expires_at',
    ]) {
      assert.ok(indexNames.has(name), `缺少索引 ${name}`);
    }

    const journal = db.prepare('PRAGMA journal_mode').get() as unknown as {
      journal_mode: string;
    };
    assert.equal(journal.journal_mode, 'wal');

    const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as unknown as {
      foreign_keys: number;
    };
    assert.equal(foreignKeys.foreign_keys, 1);

    const busyTimeout = db.prepare('PRAGMA busy_timeout').get() as unknown as {
      timeout: number;
    };
    assert.equal(busyTimeout.timeout, 5000);

    // v2 列：accounts.updated_at NOT NULL、last_login_at 可空。
    const accountColumns = tableColumns(db, 'accounts');
    const updatedAt = accountColumns.find((column) => column.name === 'updated_at');
    assert.ok(updatedAt, 'accounts 缺少 updated_at');
    assert.equal(updatedAt.notnull, 1);
    const lastLoginAt = accountColumns.find((column) => column.name === 'last_login_at');
    assert.ok(lastLoginAt, 'accounts 缺少 last_login_at');
    assert.equal(lastLoginAt.notnull, 0);

    // v2 列：issue_replies.author NOT NULL DEFAULT ''。
    const replyAuthor = tableColumns(db, 'issue_replies').find((column) => column.name === 'author');
    assert.ok(replyAuthor, 'issue_replies 缺少 author');
    assert.equal(replyAuthor.notnull, 1);
    assert.equal(replyAuthor.dflt_value, "''");

    // v2 列：login_codes.game_id NOT NULL，且忽略大小写。
    const gameId = tableColumns(db, 'login_codes').find((column) => column.name === 'game_id');
    assert.ok(gameId, 'login_codes 缺少 game_id');
    assert.equal(gameId.notnull, 1);
    const loginCodesSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'login_codes'")
      .get() as unknown as { sql: string };
    assert.match(loginCodesSql.sql, /game_id TEXT COLLATE NOCASE NOT NULL/);

    assert.equal(metaValue(db, 'schema_version'), '2');
  });
});

test('databasePath 优先 HYDWIND_DB_PATH，并自动创建父目录', () => {
  withTempEnv(
    (dir) => {
      const custom = path.join(dir, 'custom', 'nested', 'app.sqlite');
      assert.equal(databasePath(), custom);

      const db = getDb();
      assert.ok(existsSync(custom));
      assert.equal(metaValue(db, 'schema_version'), '2');
    },
    { dbPath: (dir) => path.join(dir, 'custom', 'nested', 'app.sqlite') }
  );
});

test(':memory: 特殊路径不创建数据目录', () => {
  withTempEnv(
    (dir) => {
      assert.equal(databasePath(), ':memory:');
      assert.deepEqual(readdirSync(dir), []);

      const db = getDb();
      const journal = db.prepare('PRAGMA journal_mode').get() as unknown as {
        journal_mode: string;
      };
      assert.equal(journal.journal_mode, 'memory');
      assert.equal(metaValue(db, 'schema_version'), '2');

      // 目录仍然为空（不会为 :memory: 建 data 目录或写文件）。
      assert.deepEqual(readdirSync(dir), []);
    },
    { dbPath: () => ':memory:' }
  );
});

test('foreign_keys 开启后拒绝悬空外键', () => {
  withTempEnv(() => {
    const db = getDb();

    assert.throws(
      () => {
        db.prepare(
          'INSERT INTO comments (id, game_id, author_username, author_game_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('ghost-comment', 'missing-biography', 'alice', 'alice', 'x', new Date().toISOString());
      },
      /FOREIGN KEY constraint failed/
    );
  });
});

test('withTransaction 提交成功、回滚失败并透传返回值', () => {
  withTempEnv(() => {
    const db = getDb();

    const returned = withTransaction(() => {
      setMeta(db, 'tx-commit', 'ok');
      return 42;
    });
    assert.equal(returned, 42);
    assert.equal(metaValue(db, 'tx-commit'), 'ok');

    assert.throws(
      () =>
        withTransaction(() => {
          setMeta(db, 'tx-rollback', 'should-not-persist');
          throw new Error('boom');
        }),
      /boom/
    );
    assert.equal(metaValue(db, 'tx-rollback'), undefined);
  });
});

test('closeDb 后重新 getDb 保留数据', () => {
  withTempEnv(() => {
    const first = getDb();
    setMeta(first, 'persist', 'yes');
    closeDb();

    const second = getDb();
    assert.equal(metaValue(second, 'persist'), 'yes');
    assert.equal(metaValue(second, 'schema_version'), '2');
  });
});

test('v1 老库幂等升级到 v2（补列、放开 last_login_at、二次打开不重复迁移）', () => {
  withTempEnv((dir) => {
    const dbFile = path.join(dir, 'hydwind.sqlite');
    const createdAt = '2026-01-01T00:00:00.000Z';
    const lastLoginAt = '2026-02-01T00:00:00.000Z';

    const raw = new DatabaseSync(dbFile);
    try {
      raw.exec(V1_SCHEMA_SQL);
      raw
        .prepare(
          'INSERT INTO accounts (username, nickname, platform, platform_id, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('Alice', '爱丽丝', 'qq', '10001', 'scrypt$a$b', 'admin', createdAt, lastLoginAt);
      // v1 用空串表示从未登录，升级后应变成 NULL。
      raw
        .prepare(
          'INSERT INTO accounts (username, nickname, platform, platform_id, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('Bob', '鲍勃', 'qq', '10002', 'scrypt$c$d', 'member', createdAt, '');
      raw
        .prepare(
          'INSERT INTO issues (id, title, body, category, status, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(1, '旧议题', '旧议题正文', 'bug', 'open', 'Alice', createdAt, createdAt);
      raw
        .prepare(
          'INSERT INTO issue_replies (issue_id, body, staff, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(1, '旧回复', 1, createdAt);
      raw
        .prepare(
          'INSERT INTO login_codes (id, username, kaomoji, ascii, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run('code-1', 'Alice', '(＾▽＾)', 'HWG-AAAA', 1, 2, null);
      raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
      // 已导入过 JSON 的库：跳过导入分支，聚焦迁移本身。
      raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('json_import_v1', 'done');
    } finally {
      raw.close();
    }

    const db = getDb();

    const accountColumns = tableColumns(db, 'accounts');
    assert.equal(
      accountColumns.find((column) => column.name === 'updated_at')?.notnull,
      1,
      '老库应补出 NOT NULL 的 updated_at'
    );
    assert.equal(
      accountColumns.find((column) => column.name === 'last_login_at')?.notnull,
      0,
      '老库的 last_login_at 应改为可空'
    );

    const account = db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get('Alice') as unknown as Record<string, unknown>;
    assert.equal(account.username, 'Alice');
    assert.equal(account.nickname, '爱丽丝');
    assert.equal(account.role, 'admin');
    assert.equal(account.updated_at, createdAt);
    // 已有的非空登录时间保留。
    assert.equal(account.last_login_at, lastLoginAt);

    const neverLoggedIn = db
      .prepare('SELECT last_login_at FROM accounts WHERE username = ?')
      .get('Bob') as unknown as Record<string, unknown>;
    // v1 空串哨兵在升级时归一为 NULL。
    assert.equal(neverLoggedIn.last_login_at, null);

    // v2 后该列真正可写 NULL。
    db.prepare('UPDATE accounts SET last_login_at = NULL WHERE username = ?').run('Alice');
    const cleared = db
      .prepare('SELECT last_login_at FROM accounts WHERE username = ?')
      .get('Alice') as unknown as Record<string, unknown>;
    assert.equal(cleared.last_login_at, null);

    const replyAuthor = tableColumns(db, 'issue_replies').find((column) => column.name === 'author');
    assert.equal(replyAuthor?.notnull, 1);
    assert.equal(replyAuthor?.dflt_value, "''");
    const reply = db
      .prepare('SELECT author, body, staff FROM issue_replies')
      .get() as unknown as Record<string, unknown>;
    assert.equal(reply.author, '');
    assert.equal(reply.body, '旧回复');
    assert.equal(reply.staff, 1);

    const gameId = tableColumns(db, 'login_codes').find((column) => column.name === 'game_id');
    assert.equal(gameId?.notnull, 1);
    const loginCode = db
      .prepare('SELECT username, game_id FROM login_codes')
      .get() as unknown as Record<string, unknown>;
    assert.equal(loginCode.username, 'Alice');
    assert.equal(loginCode.game_id, '');

    assert.equal(metaValue(db, 'schema_version'), '2');
    closeDb();

    // 再次打开：迁移函数应全部短路，不报错且不重复写数据。
    const reopened = getDb();
    assert.equal(metaValue(reopened, 'schema_version'), '2');
    assert.equal(tableColumns(reopened, 'issue_replies').filter((c) => c.name === 'author').length, 1);
    assert.equal(tableColumns(reopened, 'login_codes').filter((c) => c.name === 'game_id').length, 1);

    const counts = reopened
      .prepare(
        'SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM issue_replies) AS replies, (SELECT COUNT(*) FROM login_codes) AS codes'
      )
      .get() as unknown as { accounts: number; replies: number; codes: number };
    assert.deepEqual(
      { accounts: counts.accounts, replies: counts.replies, codes: counts.codes },
      { accounts: 2, replies: 1, codes: 1 }
    );
  });
});