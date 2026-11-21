import { getDb } from '../db/database.ts';

/**
 * 上游响应缓存。
 *
 * 生产环境落到 SQLite 的 `upstream_cache`（P1 已建表）；测试用内存实现，
 * 这样纯逻辑用例不需要临时数据库。接口刻意保持同步：node:sqlite 是同步
 * API，异步包装只会增加无意义的 Promise。
 */
export interface CacheStore {
  get(key: string, now: number): string | null;
  set(key: string, body: string, ttlMs: number, now: number): void;
  delete(key: string): void;
}

interface CacheRow {
  body: string;
  expires_at: number;
}

export const sqliteCacheStore = (): CacheStore => ({
  get(key, now) {
    const row = getDb()
      .prepare('SELECT body, expires_at FROM upstream_cache WHERE key = ?')
      .get(key) as unknown as CacheRow | undefined;
    if (!row || row.expires_at <= now) return null;
    return row.body;
  },

  set(key, body, ttlMs, now) {
    const db = getDb();
    db.prepare(
      `INSERT INTO upstream_cache (key, body, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         body = excluded.body,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`
    ).run(key, body, now, now + ttlMs);
  },

  delete(key) {
    getDb().prepare('DELETE FROM upstream_cache WHERE key = ?').run(key);
  },
});

export const memoryCacheStore = (): CacheStore => {
  const entries = new Map<string, { body: string; expiresAt: number }>();

  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return null;
      }
      return entry.body;
    },

    set(key, body, ttlMs, now) {
      entries.set(key, { body, expiresAt: now + ttlMs });
    },

    delete(key) {
      entries.delete(key);
    },
  };
};
