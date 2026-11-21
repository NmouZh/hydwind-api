/**
 * SQLite schema。
 *
 * 全部语句使用 IF NOT EXISTS，启动时可以反复执行。`meta.schema_version`
 * 目前为 2；老库缺列由 database.ts 的幂等迁移补齐，而不是改这里的历史 DDL。
 * v2 变更：accounts 增加 updated_at 并允许 last_login_at 为 NULL；
 * issue_replies 增加 author；login_codes 增加 game_id。
 *
 * 表都声明 STRICT：类型错误在写入时就暴露，避免旧 JSON 里的脏值
 * 悄悄变成另一种类型。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  username TEXT COLLATE NOCASE PRIMARY KEY,
  nickname TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (platform, platform_id)
) STRICT;

CREATE TABLE IF NOT EXISTS biographies (
  game_id TEXT COLLATE NOCASE PRIMARY KEY,
  main_title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  game_id TEXT COLLATE NOCASE NOT NULL REFERENCES biographies(game_id) ON DELETE CASCADE,
  author_username TEXT COLLATE NOCASE NOT NULL,
  author_game_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_comments_game_id ON comments(game_id, created_at);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, body TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('bug','suggestion','other')),
  status TEXT NOT NULL CHECK (status IN ('pending','open','rejected','done')),
  author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS issue_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL, staff INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_issue_replies_issue_id ON issue_replies(issue_id, id);

CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,
  username TEXT COLLATE NOCASE NOT NULL,
  game_id TEXT COLLATE NOCASE NOT NULL,
  kaomoji TEXT NOT NULL UNIQUE,
  ascii TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_login_codes_expires_at ON login_codes(expires_at);

CREATE TABLE IF NOT EXISTS upstream_cache (
  key TEXT PRIMARY KEY, body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
`;