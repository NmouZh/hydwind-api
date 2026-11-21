import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importLegacyJson } from './import-json.ts';
import { SCHEMA_SQL } from './schema.ts';

/**
 * SQLite 连接管理。
 *
 * 单实例进程只保留一个连接：`node:sqlite` 是同步 API，单连接省掉了
 * 连接池和跨线程的复杂度，也符合本服务「单实例部署」的前提。
 *
 * 路径优先级：HYDWIND_DB_PATH > HYDWIND_DATA_DIR/hydwind.sqlite。
 * 后者与旧 JSON 数据文件共用一个目录，方便首次启动就地导入。
 */

let database: DatabaseSync | null = null;

const SCHEMA_VERSION = '2';

interface ColumnInfo {
  name: string;
  notnull: number;
}

/**
 * accounts v2 的完整表定义。重建表时不能复用 SCHEMA_SQL 里的
 * `CREATE TABLE IF NOT EXISTS`，否则会命中旧表而什么都不做；这里刻意重复
 * 一份同构 DDL，改 schema.ts 时两边要一起改。
 */
const ACCOUNTS_V2_TABLE_SQL = `
CREATE TABLE accounts_migrate_v2 (
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
`;

const tableColumns = (db: DatabaseSync, table: string): ColumnInfo[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];

const addColumnIfMissing = (
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void => {
  if (tableColumns(db, table).some((info) => info.name === column)) return;
  // ALTER ADD COLUMN 的 NOT NULL 列必须带常量默认值；老行会先拿到默认值。
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
};

/**
 * 老库的 last_login_at 是 NOT NULL，SQLite 不支持直接修改列约束，
 * 只能按官方推荐方式重建表。accounts 没有被其它表引用，可以安全 DROP。
 */
const rebuildAccountsTable = (db: DatabaseSync, hasLastLoginAt: boolean): void => {
  // v1 用空串表示「从未登录」；升级时归一成真正的 NULL。
  const lastLoginAtExpression = hasLastLoginAt ? "NULLIF(last_login_at, '')" : 'NULL';

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE IF EXISTS accounts_migrate_v2');
    db.exec(ACCOUNTS_V2_TABLE_SQL);
    db.exec(`
      INSERT INTO accounts_migrate_v2
        (username, nickname, platform, platform_id, password_hash, role, created_at, updated_at, last_login_at)
      SELECT
        username, nickname, platform, platform_id, password_hash, role, created_at, updated_at,
        ${lastLoginAtExpression}
      FROM accounts
    `);
    db.exec('DROP TABLE accounts');
    db.exec('ALTER TABLE accounts_migrate_v2 RENAME TO accounts');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始错误。
    }
    throw error;
  }
};

const migrateAccountsTable = (db: DatabaseSync): void => {
  let columns = tableColumns(db, 'accounts');

  if (!columns.some((info) => info.name === 'updated_at')) {
    db.exec("ALTER TABLE accounts ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    // v1 没有保存旧 updatedAt，用 createdAt 作为升级后的初始值。
    db.exec("UPDATE accounts SET updated_at = created_at WHERE updated_at = ''");
    columns = tableColumns(db, 'accounts');
  }

  const lastLoginAt = columns.find((info) => info.name === 'last_login_at');
  // 新库（或已迁移库）该列可空，无需重建。
  if (lastLoginAt?.notnull === 0) return;

  rebuildAccountsTable(db, lastLoginAt !== undefined);
};

/** 幂等列迁移：新库无操作，v1 老库补齐 v2 列。 */
const migrateSchema = (db: DatabaseSync): void => {
  addColumnIfMissing(db, 'issue_replies', 'author', "author TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(
    db,
    'login_codes',
    'game_id',
    "game_id TEXT COLLATE NOCASE NOT NULL DEFAULT ''"
  );
  migrateAccountsTable(db);
};

/** 当前数据库文件路径；每次按环境变量重新计算，便于测试在打开前改环境。 */
export const databasePath = (): string => {
  const explicitPath = process.env.HYDWIND_DB_PATH?.trim();
  if (explicitPath) return explicitPath;

  const dataDir = process.env.HYDWIND_DATA_DIR?.trim() || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'hydwind.sqlite');
};

const openDatabase = (): DatabaseSync => {
  const file = databasePath();
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  try {
    // WAL 让读写不互相阻塞；单文件部署下比默认的 rollback journal 更适合 Web 服务。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA_SQL);

    // SCHEMA_SQL 只负责新表；已有 v1 表要在这里补齐 v2 列（幂等）。
    migrateSchema(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      SCHEMA_VERSION
    );

    // 导入是幂等的：内部用 meta.json_import_v1 标记，重复调用直接返回。
    importLegacyJson(db);
    return db;
  } catch (error) {
    // 初始化失败时不要留下半开的连接，否则测试无法在修复数据后重试。
    // 关闭本身失败不值得覆盖原始错误。
    try {
      db.close();
    } catch {
      // 忽略
    }
    throw error;
  }
};

/** 懒加载单例；第一次调用时建库、建表并执行一次旧 JSON 导入。 */
export const getDb = (): DatabaseSync => {
  database ??= openDatabase();
  return database;
};

/** 关闭连接并把单例复位，下次 getDb 会重新打开。 */
export const closeDb = (): void => {
  const db = database;
  database = null;
  db?.close();
};

/**
 * 在 BEGIN IMMEDIATE 事务里执行同步回调。
 *
 * 只支持同步回调：node:sqlite 本身是同步的，异步回调会让事务在 await
 * 之前就提交。回调抛错时回滚并原样重抛。
 */
export const withTransaction = <T>(fn: () => T): T => {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败（例如连接已关闭）时保留原始错误更有诊断价值。
    }
    throw error;
  }
};