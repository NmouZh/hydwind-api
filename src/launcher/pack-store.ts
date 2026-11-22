import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError } from './errors.ts';
import { finalizeClientPack, parseStoredClientPack } from './client-pack.ts';
import type { ClientPack, ClientPackDraft } from './client-pack.ts';

/**
 * 客户端包文件存储。
 *
 * 目录布局：
 *
 *   current.json
 *   versions/<packVersion>/pack.json
 *   versions/<packVersion>/overrides.zip
 *
 * 发布先写临时版本目录、rename 成正式目录，再原子替换 current.json；
 * 任一前置步骤失败都回滚，current 保持不变。同一目录的发布在进程内排队，
 * 并发请求不会拿到同一个 packVersion。旧版本删除失败只记日志。
 */

export interface ClientPackStoreOptions {
  dir: string;
  /** 保留版本数（含 current），默认 5。 */
  retainVersions?: number;
  logger?: (message: string) => void;
}

export interface StoredClientPack {
  /** pack.json 原始字节；ETag 与响应体都直接用它，避免任何重编码。 */
  raw: Buffer;
  pack: ClientPack;
}

export interface ClientPackPublishInput {
  draft: ClientPackDraft;
  /** 原样落盘的 overrides.zip；没有配置覆盖时为 null。 */
  overrides: Buffer | null;
}

export interface ClientPackStore {
  readCurrent(): Promise<StoredClientPack | null>;
  readOverrides(packVersion: number): Promise<Buffer | null>;
  publish(input: ClientPackPublishInput): Promise<ClientPack>;
}

const VERSION_PATTERN = /^[1-9]\d*$/;
const DEFAULT_RETAIN = 5;

/** current.json 内容损坏（不同于 EACCES/EIO 等文件系统错误）。 */
class CorruptCurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptCurrentError';
  }
}

const suffix = (): string => randomBytes(8).toString('hex');

/** 按目录串行化发布：前一次失败不会阻塞后一次。 */
const pendingByDir = new Map<string, Promise<void>>();

const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = pendingByDir.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  pendingByDir.set(key, tail);
  void tail.then(() => {
    if (pendingByDir.get(key) === tail) pendingByDir.delete(key);
  });
  return run;
};

const readCurrentVersion = async (base: string): Promise<number | null> => {
  let raw: string;
  try {
    raw = await readFile(path.join(base, 'current.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptCurrentError('current.json 不是合法 JSON');
  }

  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const packVersion = record?.packVersion;
  if (
    typeof packVersion !== 'number' ||
    !Number.isSafeInteger(packVersion) ||
    packVersion < 1
  ) {
    throw new CorruptCurrentError('current.json 的 packVersion 不合法');
  }
  return packVersion;
};

const listVersions = async (base: string): Promise<number[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(base, 'versions'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((version) => Number.isSafeInteger(version))
    .sort((left, right) => left - right);
};

const writeCurrentVersion = async (base: string, packVersion: number): Promise<void> => {
  const temp = path.join(base, `current.json.tmp-${suffix()}`);
  try {
    await writeFile(temp, `${JSON.stringify({ packVersion }, null, 2)}\n`);
    await rename(temp, path.join(base, 'current.json'));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * 删除超出保留数量的旧版本。这里绝不抛错：发布已经成功，清理只是维护动作。
 */
const pruneVersions = async (
  base: string,
  next: number,
  retain: number,
  log: (message: string) => void
): Promise<void> => {
  const cutoff = next - (retain - 1);
  let versions: number[];
  try {
    versions = await listVersions(base);
  } catch (error) {
    log(`列出旧版本失败: ${(error as Error).message}`);
    return;
  }

  for (const version of versions) {
    if (version >= cutoff) continue;
    try {
      await rm(path.join(base, 'versions', String(version)), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      log(`删除旧版本 ${version} 失败: ${(error as Error).message}`);
    }
  }
};

const missingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

export const createClientPackStore = (options: ClientPackStoreOptions): ClientPackStore => {
  const base = path.resolve(options.dir);
  const retain = options.retainVersions ?? DEFAULT_RETAIN;
  const log =
    options.logger ??
    ((message: string) => {
      console.error(`[hydwind-api] launcher client pack: ${message}`);
    });

  const readCurrent = async (): Promise<StoredClientPack | null> => {
    const packVersion = await readCurrentVersion(base);
    if (packVersion === null) return null;

    const raw = await readFile(
      path.join(base, 'versions', String(packVersion), 'pack.json')
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('pack.json 不是合法 JSON');
    }

    let pack: ClientPack;
    try {
      pack = parseStoredClientPack(parsed);
    } catch (error) {
      if (error instanceof BadRequestError) {
        throw new Error(`pack.json 不合法：${error.message}`);
      }
      throw error;
    }

    if (pack.packVersion !== packVersion) {
      throw new Error('current.json 与 pack.json 的 packVersion 不一致');
    }
    return { raw, pack };
  };

  const readOverrides = async (packVersion: number): Promise<Buffer | null> => {
    if (!Number.isSafeInteger(packVersion) || packVersion < 1) return null;
    try {
      return await readFile(
        path.join(base, 'versions', String(packVersion), 'overrides.zip')
      );
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    }
  };

  const publish = (input: ClientPackPublishInput): Promise<ClientPack> =>
    enqueue(base, async () => {
      const versionsDir = path.join(base, 'versions');
      await mkdir(versionsDir, { recursive: true });

      let currentVersion: number | null;
      try {
        currentVersion = await readCurrentVersion(base);
      } catch (error) {
        if (!(error instanceof CorruptCurrentError)) throw error;
        // 内容损坏不应阻断发布：记日志后按现有版本目录续号。
        log(`current.json 内容损坏，按版本目录续号: ${error.message}`);
        currentVersion = null;
      }
      const versions = await listVersions(base);
      const next = Math.max(currentVersion ?? 0, versions.at(-1) ?? 0) + 1;

      const pack = finalizeClientPack(input.draft, next);
      // 写前自检：读取端必须能解析服务端写出的包。
      parseStoredClientPack(pack);
      const raw = `${JSON.stringify(pack, null, 2)}\n`;

      const tempDir = path.join(versionsDir, `${next}.tmp-${suffix()}`);
      const finalDir = path.join(versionsDir, String(next));
      let renamed = false;
      try {
        await mkdir(tempDir);
        await writeFile(path.join(tempDir, 'pack.json'), raw);
        if (input.overrides) {
          await writeFile(path.join(tempDir, 'overrides.zip'), input.overrides);
        }
        await rename(tempDir, finalDir);
        renamed = true;
        await writeCurrentVersion(base, next);
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true }).catch((cleanupError) => {
          log(`清理临时目录失败: ${(cleanupError as Error).message}`);
        });
        if (renamed) {
          await rm(finalDir, { recursive: true, force: true }).catch((cleanupError) => {
            log(`回滚版本目录 ${next} 失败: ${(cleanupError as Error).message}`);
          });
        }
        throw error;
      }

      await pruneVersions(base, next, retain, log);
      return pack;
    });

  return { readCurrent, readOverrides, publish };
};