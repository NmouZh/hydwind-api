import type { Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ClientPackDraft,
  ClientPackDraftOverrides,
  ClientPackMod,
  ClientLoaderType,
} from './client-pack.ts';
import {
  isSafeFilename,
  isSafeRelativePath,
  parseClientPackDraft,
  sha256Hex,
  validateOverridesZip,
} from './client-pack.ts';
import { asArray, asNumber, asRecord, asString, isValidVersionId } from './manifest.ts';
import type { JsonRecord } from './manifest.ts';
import { selectPrimaryFile } from './modrinth.ts';
import { writeZipEntries } from './zip-write.ts';

/**
 * 客户端包发布流程的可测函数。
 *
 * CLI（`scripts/publish-pack.ts`）只做参数解析与本地 I/O；这里负责：
 *
 * 1. 解析 spec（严格的 JSON 形状，未知字段直接拒绝，避免 `overridesDir`
 *    拼错后被静默忽略）；
 * 2. 从 Modrinth 解析 release 版本并递归展开 required 客户端依赖；
 * 3. 扫描 overrides 目录，生成确定性 zip 与逐文件清单；
 * 4. 组装草稿后调用 `parseClientPackDraft` 自校验，与服务端共享同一套
 *    规则，确保「发布能过、读取也能过」；
 * 5. 可选上传管理接口。
 *
 * 所有网络与时钟都可注入，测试不联网。包内始终保存 Modrinth 官方 CDN
 * 地址，即使请求走的是镜像 API。
 */

export const DEFAULT_MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
export const DEFAULT_API_BASE = 'http://127.0.0.1:8787';
export const PACK_PUBLISHER_USER_AGENT =
  'hydwind-pack-publisher/0.1.0 (https://github.com/NmouZh/hydwind-api)';

export const DEFAULT_MAX_MODS = 200;
export const MAX_MOD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_OVERRIDES_LIMITS: OverridesLimits = {
  maxFiles: 2_000,
  maxBytes: 50 * 1024 * 1024,
  maxZipBytes: 50 * 1024 * 1024,
};

const LOADER_TYPES = new Set<ClientLoaderType>(['fabric', 'quilt', 'forge', 'neoforge']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA512_PATTERN = /^[a-f0-9]{128}$/;
const MIN_LAUNCHER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CDN_PREFIX = 'https://cdn.modrinth.com/';
const MAX_NOTES = 500;
const FETCH_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 60_000;
const MODRINTH_RETRY_LIMIT = 2;
const MAX_RETRY_DELAY_MS = 5_000;

export class PackPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackPublishError';
  }
}

const fail = (message: string): never => {
  throw new PackPublishError(message);
};

// ------------------------------------------------------------------ spec

export interface ClientPackSpecMod {
  project: string;
  version?: string;
}

export interface ClientPackSpec {
  notes?: string;
  gameVersion: string;
  loader: { type: ClientLoaderType; version: string };
  java: { major: number; component?: string };
  minLauncherVersion?: string;
  mods: (string | ClientPackSpecMod)[];
  overridesDir?: string;
  modrinthApiBase?: string;
}

const SPEC_KEYS = new Set([
  'notes',
  'gameVersion',
  'loader',
  'java',
  'minLauncherVersion',
  'mods',
  'overridesDir',
  'modrinthApiBase',
]);

const requireRecord = (value: unknown, label: string): JsonRecord => {
  const record = asRecord(value);
  if (!record) return fail(`${label} 必须是对象`);
  return record;
};

const requireString = (value: unknown, label: string, max: number): string => {
  const text = asString(value)?.trim() ?? '';
  if (!text || text.length > max) fail(`${label} 不合法`);
  return text;
};

const requireInt = (value: unknown, label: string, min: number, max: number): number => {
  const number = asNumber(value);
  if (number === null || !Number.isInteger(number) || number < min || number > max) {
    return fail(`${label} 不合法`);
  }
  return number;
};

const requireProjectRef = (value: unknown, label: string): string => {
  const ref = requireString(value, label, 64);
  if (!ID_PATTERN.test(ref)) fail(`${label} 不合法`);
  return ref;
};

/**
 * 解析 spec。未知顶层字段直接拒绝：`overrideDir`（少一个 s）之类的拼写
 * 错误若被忽略，会得到一个没有配置覆盖、但看起来发布成功的包。
 */
export const parsePackSpec = (value: unknown): ClientPackSpec => {
  const record = requireRecord(value, 'spec');

  for (const key of Object.keys(record)) {
    if (!SPEC_KEYS.has(key)) fail(`spec 包含未知字段: ${key}`);
  }

  const notesValue = record.notes;
  const notes =
    notesValue === undefined ? undefined : requireString(notesValue, 'notes', MAX_NOTES);

  const gameVersion = requireString(record.gameVersion, 'gameVersion', 64);
  if (!isValidVersionId(gameVersion)) fail('gameVersion 不合法');

  const loader = requireRecord(record.loader, 'loader');
  for (const key of Object.keys(loader)) {
    if (key !== 'type' && key !== 'version') fail(`loader 包含未知字段: ${key}`);
  }
  const type = requireString(loader.type, 'loader.type', 16) as ClientLoaderType;
  if (!LOADER_TYPES.has(type)) fail('loader.type 不合法');
  const loaderVersion = requireString(loader.version, 'loader.version', 64);
  if (!isValidVersionId(loaderVersion)) fail('loader.version 不合法');

  const javaRecord = requireRecord(record.java, 'java');
  for (const key of Object.keys(javaRecord)) {
    if (key !== 'major' && key !== 'component') fail(`java 包含未知字段: ${key}`);
  }
  const major = requireInt(javaRecord.major, 'java.major', 1, 99);
  const componentValue = javaRecord.component;
  const component =
    componentValue === undefined
      ? undefined
      : requireString(componentValue, 'java.component', 64);

  const minLauncherValue = record.minLauncherVersion;
  const minLauncherVersion =
    minLauncherValue === undefined
      ? undefined
      : requireString(minLauncherValue, 'minLauncherVersion', 32);
  if (minLauncherVersion !== undefined && !MIN_LAUNCHER_PATTERN.test(minLauncherVersion)) {
    fail('minLauncherVersion 不合法');
  }

  if (!Array.isArray(record.mods)) fail('mods 必须是数组');
  const seenInputs = new Set<string>();
  const mods: ClientPackSpecMod[] = (record.mods as unknown[]).map((item, index) => {
    const label = `mods[${index}]`;
    if (typeof item === 'string') {
      const project = requireProjectRef(item, label);
      if (seenInputs.has(project)) fail(`mods 中项目重复: ${project}`);
      seenInputs.add(project);
      return { project };
    }

    const mod = requireRecord(item, label);
    for (const key of Object.keys(mod)) {
      if (key !== 'project' && key !== 'version') fail(`${label} 包含未知字段: ${key}`);
    }
    const project = requireProjectRef(mod.project, `${label}.project`);
    if (seenInputs.has(project)) fail(`mods 中项目重复: ${project}`);
    seenInputs.add(project);

    const versionValue = mod.version;
    const version =
      versionValue === undefined ? undefined : requireProjectRef(versionValue, `${label}.version`);
    return version === undefined ? { project } : { project, version };
  });

  const overridesValue = record.overridesDir;
  const overridesDir =
    overridesValue === undefined
      ? undefined
      : requireString(overridesValue, 'overridesDir', 1_000);

  const modrinthValue = record.modrinthApiBase;
  let modrinthApiBase: string | undefined;
  if (modrinthValue !== undefined) {
    const base = requireString(modrinthValue, 'modrinthApiBase', 500);
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      return fail('modrinthApiBase 不是合法 URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      fail('modrinthApiBase 必须是 HTTP(S) 地址');
    }
    modrinthApiBase = base.replace(/\/+$/, '');
  }

  return {
    notes,
    gameVersion,
    loader: { type, version: loaderVersion },
    java: component === undefined ? { major } : { major, component },
    minLauncherVersion,
    mods,
    overridesDir,
    modrinthApiBase,
  };
};

// -------------------------------------------------------------- overrides

export interface OverridesLimits {
  maxFiles: number;
  maxBytes: number;
  maxZipBytes: number;
}

export interface OverridesPayload {
  zip: Buffer;
  manifest: ClientPackDraftOverrides;
}

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const mergeOverridesLimits = (limits: Partial<OverridesLimits> = {}): OverridesLimits => ({
  maxFiles: limits.maxFiles ?? DEFAULT_OVERRIDES_LIMITS.maxFiles,
  maxBytes: limits.maxBytes ?? DEFAULT_OVERRIDES_LIMITS.maxBytes,
  maxZipBytes: limits.maxZipBytes ?? DEFAULT_OVERRIDES_LIMITS.maxZipBytes,
});

const isUnsafeSegment = (name: string): boolean =>
  name === '' ||
  name === '.' ||
  name === '..' ||
  name.includes('/') ||
  name.includes('\\') ||
  /[\u0000-\u001f]/.test(name) ||
  // Windows 保留字符：Linux 上能建出这些名字，但无法跨平台解压。
  /[<>:"|?*]/.test(name) ||
  // 首尾空白（含 NBSP）不能保留：服务端解析清单时会 trim 路径，
  // 保留会让 pack.json 与 zip 条目不一致。
  name !== name.trim();

/**
 * 递归扫描 overrides 目录。拒绝符号链接、非普通文件、绝对路径、`..`、
 * 反斜杠、控制字符、Windows 保留字符、首尾空白（服务端会 trim 路径）
 * 和超过契约长度上限的路径；只把相对路径（`/` 分隔）写进清单。目录不存在
 * 或不是目录时报错（由 spec 作者修正，而不是静默发布一个缺少配置的包）。
 */
export const buildOverridesPayload = async (
  dir: string,
  limits: Partial<OverridesLimits> = {}
): Promise<OverridesPayload | null> => {
  const { maxFiles, maxBytes, maxZipBytes } = mergeOverridesLimits(limits);

  // 先 resolve 去掉尾斜杠：`lstat('link/')` 会跟随符号链接，
  // 根目录的符号链接检查会失效。
  const root = resolve(dir);
  let rootStat: Stats;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fail(`overrides 目录不存在: ${root}`);
    return fail(`无法读取 overrides 目录 ${root}: ${(error as Error).message}`);
  }
  if (rootStat.isSymbolicLink()) fail('overrides 目录不能是符号链接');
  if (!rootStat.isDirectory()) fail(`overrides 路径不是目录: ${root}`);

  const files: { path: string; content: Buffer }[] = [];
  let totalBytes = 0;

  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of entries) {
      if (isUnsafeSegment(entry.name)) {
        fail(`overrides 路径不合法: ${relative ? `${relative}/${entry.name}` : entry.name}`);
      }
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeRelativePath(path)) fail(`overrides 路径不合法: ${path}`);

      if (entry.isSymbolicLink()) fail(`overrides 不允许符号链接: ${path}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) fail(`overrides 只允许普通文件: ${path}`);

      if (files.length + 1 > maxFiles) fail(`overrides 文件数量超过上限 ${maxFiles}`);

      // 先 lstat 确认普通文件并按剩余额度校验大小，再 readFile；
      // 否则超大文件会先被整份读进内存才拒绝。
      let stat: Stats;
      try {
        stat = await lstat(join(root, path));
      } catch (error) {
        return fail(`无法读取 overrides 文件 ${path}: ${(error as Error).message}`);
      }
      if (!stat.isFile()) fail(`overrides 只允许普通文件: ${path}`);
      const remaining = maxBytes - totalBytes;
      if (stat.size > remaining) {
        fail(
          `overrides 解压后总量超过上限 ${maxBytes} 字节` +
            `（剩余额度 ${remaining}，${path} ${stat.size} 字节）`
        );
      }

      const content = await readFile(join(root, path));
      totalBytes += content.length;
      if (totalBytes > maxBytes) fail(`overrides 解压后总量超过上限 ${maxBytes} 字节`);
      files.push({ path, content });
    }
  };

  await walk('');
  if (files.length === 0) return null;

  files.sort((left, right) => comparePaths(left.path, right.path));

  const zip = writeZipEntries(files.map((file) => ({ path: file.path, data: file.content })));
  if (zip.length > maxZipBytes) fail(`overrides.zip 超过大小上限 ${maxZipBytes} 字节`);

  const manifest: ClientPackDraftOverrides = {
    sha256: sha256Hex(zip),
    size: zip.length,
    files: files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.content),
      size: file.content.length,
    })),
  };

  return { zip, manifest };
};

// --------------------------------------------------------------- Modrinth

interface ModrinthClient {
  fetchImpl: typeof fetch;
  baseUrl: string;
}

interface ModrinthState {
  client: ModrinthClient;
  versionLists: Map<string, JsonRecord[]>;
  versions: Map<string, JsonRecord>;
}

interface ProjectInfo {
  id: string;
  slug: string;
  title: string;
  clientSide: string | null;
}

const stringList = (value: unknown): string[] =>
  asArray(value).filter((item): item is string => typeof item === 'string');

const loaderAccepts = (loader: ClientLoaderType, versionLoaders: string[]): boolean =>
  // Quilt 兼容 Fabric mod；Forge 与 NeoForge 不互认。
  loader === 'quilt'
    ? versionLoaders.includes('quilt') || versionLoaders.includes('fabric')
    : versionLoaders.includes(loader);

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;

/** Retry-After 只接受秒数；延迟封顶，避免一次发布卡太久。 */
const retryAfterMs = (value: string | null): number | null => {
  if (value === null) return null;
  const text = value.trim();
  if (!text) return null;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
};

const modrinthGet = async (client: ModrinthClient, path: string): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await client.fetchImpl(`${client.baseUrl}${path}`, {
        headers: {
          'user-agent': PACK_PUBLISHER_USER_AGENT,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PackPublishError(
        `Modrinth 请求失败：${path}（${(error as Error).message}）`
      );
    }

    if (!response.ok) {
      const delay = retryAfterMs(response.headers.get('retry-after'));
      if (
        attempt < MODRINTH_RETRY_LIMIT &&
        RETRYABLE_STATUS(response.status) &&
        delay !== null
      ) {
        // 404 等不重试；429/5xx 只在服务端明确给出 Retry-After 时退避。
        await response.text().catch(() => '');
        if (delay > 0) {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, delay);
          });
        }
        continue;
      }
      throw new PackPublishError(`Modrinth 请求失败（HTTP ${response.status}）：${path}`);
    }

    try {
      return await response.json();
    } catch {
      throw new PackPublishError(`Modrinth 响应不是合法 JSON：${path}`);
    }
  }
};

const fetchProject = async (client: ModrinthClient, reference: string): Promise<ProjectInfo> => {
  if (!ID_PATTERN.test(reference)) fail(`项目 id 或 slug 不合法: ${reference}`);

  const record = asRecord(
    await modrinthGet(client, `/project/${encodeURIComponent(reference)}`)
  );
  if (!record) return fail(`Modrinth 项目响应不是对象: ${reference}`);

  const id = asString(record.id)?.trim() ?? '';
  if (!ID_PATTERN.test(id)) fail(`Modrinth 项目 id 不合法: ${reference}`);

  return {
    id,
    slug: asString(record.slug)?.trim() ?? id,
    title: asString(record.title)?.trim() ?? '',
    clientSide: asString(record.client_side),
  };
};

const fetchVersionList = async (
  state: ModrinthState,
  projectId: string
): Promise<JsonRecord[]> => {
  const cached = state.versionLists.get(projectId);
  if (cached) return cached;

  const data = await modrinthGet(
    state.client,
    `/project/${encodeURIComponent(projectId)}/version`
  );
  if (!Array.isArray(data)) return fail(`Modrinth 版本列表不是数组: ${projectId}`);

  const versions = (data as unknown[])
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);

  for (const version of versions) {
    const owner = asString(version.project_id)?.trim() ?? '';
    if (owner !== projectId) {
      return fail(
        `Modrinth 版本列表包含其他项目的版本: ${asString(version.id) ?? '(缺少 id)'}` +
          `（期望 ${projectId}，实际 ${owner || '缺失'}）`
      );
    }
  }

  state.versionLists.set(projectId, versions);
  return versions;
};

const fetchVersion = async (state: ModrinthState, versionId: string): Promise<JsonRecord> => {
  if (!ID_PATTERN.test(versionId)) fail(`版本 id 不合法: ${versionId}`);

  const cached = state.versions.get(versionId);
  if (cached) return cached;

  const record = asRecord(
    await modrinthGet(state.client, `/version/${encodeURIComponent(versionId)}`)
  );
  if (!record) return fail(`Modrinth 版本响应不是对象: ${versionId}`);
  state.versions.set(versionId, record);
  return record;
};

const publishedAt = (version: JsonRecord): number => {
  const parsed = Date.parse(asString(version.date_published) ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
};

const assertCompatible = (
  version: JsonRecord,
  spec: ClientPackSpec,
  projectId: string
): void => {
  const versionId = asString(version.id)?.trim() ?? '';
  if (!stringList(version.game_versions).includes(spec.gameVersion)) {
    fail(`项目 ${projectId} 的版本 ${versionId} 不支持游戏版本 ${spec.gameVersion}`);
  }
  if (!loaderAccepts(spec.loader.type, stringList(version.loaders))) {
    fail(`项目 ${projectId} 的版本 ${versionId} 不兼容加载器 ${spec.loader.type}`);
  }
};

/**
 * 选版本：
 * - 显式 `version` 直接使用该 versionId，但仍校验游戏版本与加载器；
 * - 否则取该项目的全部版本后自行过滤（Modrinth 端点不接受服务端过滤），
 *   只要 `release`，按 `date_published` 取最新，日期相同按 version id 稳定
 *   排序。
 */
const resolveVersion = async (
  state: ModrinthState,
  project: ProjectInfo,
  exactVersionId: string | undefined,
  spec: ClientPackSpec
): Promise<JsonRecord> => {
  if (exactVersionId) {
    const version = await fetchVersion(state, exactVersionId);
    const owner = asString(version.project_id)?.trim() ?? '';
    if (owner !== project.id) {
      fail(`版本 ${exactVersionId} 不属于项目 ${project.id}`);
    }
    assertCompatible(version, spec, project.id);
    return version;
  }

  const candidates = (await fetchVersionList(state, project.id)).filter((version) => {
    if (asString(version.version_type) !== 'release') return false;
    if (!stringList(version.game_versions).includes(spec.gameVersion)) return false;
    return loaderAccepts(spec.loader.type, stringList(version.loaders));
  });

  if (candidates.length === 0) {
    fail(
      `项目 ${project.id} 没有兼容 gameVersion=${spec.gameVersion}、` +
        `loader=${spec.loader.type} 的 release 版本`
    );
  }

  candidates.sort((left, right) => {
    const diff = publishedAt(right) - publishedAt(left);
    if (diff !== 0) return diff;
    const leftId = asString(left.id) ?? '';
    const rightId = asString(right.id) ?? '';
    return comparePaths(rightId, leftId);
  });

  return candidates[0];
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** 版本 → 包内 mod 条目；主文件缺 sha512/size/CDN URL 都拒绝。 */
const toMod = (project: ProjectInfo, version: JsonRecord): ClientPackMod => {
  const versionId = asString(version.id)?.trim() ?? '';
  if (!ID_PATTERN.test(versionId)) fail(`项目 ${project.id} 的版本 id 不合法: ${versionId}`);

  const file = selectPrimaryFile(asArray(version.files));
  if (!file) return fail(`项目 ${project.id} 的版本 ${versionId} 缺少文件`);

  const filename = asString(file.filename)?.trim() ?? '';
  if (!filename || !isSafeFilename(filename)) {
    fail(`项目 ${project.id} 的版本 ${versionId} 缺少合法文件名`);
  }

  const hashes = asRecord(file.hashes);
  const sha512 = asString(hashes?.sha512)?.trim().toLowerCase() ?? '';
  if (!SHA512_PATTERN.test(sha512)) {
    fail(`项目 ${project.id} 的版本 ${versionId} 缺少合法的 sha512`);
  }

  const size = asNumber(file.size);
  if (size === null || !Number.isInteger(size) || size < 1 || size > MAX_MOD_BYTES) {
    return fail(`项目 ${project.id} 的版本 ${versionId} 缺少合法的 size`);
  }

  const url = asString(file.url)?.trim() ?? '';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return fail(`项目 ${project.id} 的版本 ${versionId} 缺少合法的 URL`);
  }
  // 官方 CDN 地址：即使元数据来自镜像 API，包里也只落官方地址，
  // 启动器再按需要重写成镜像。
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'cdn.modrinth.com' ||
    !url.startsWith(CDN_PREFIX)
  ) {
    fail(`项目 ${project.id} 的版本 ${versionId} 的 URL 必须是 ${CDN_PREFIX}`);
  }

  const name =
    truncate(project.title || (asString(version.name)?.trim() ?? '') || project.slug, 100) ||
    project.id;
  const versionNumber =
    truncate((asString(version.version_number)?.trim() ?? '') || versionId, 64) || versionId;

  return {
    projectId: project.id,
    versionId,
    name,
    versionNumber,
    filename,
    url,
    sha512,
    size,
  };
};

interface PendingDependency {
  parent: string;
  dependency: JsonRecord;
}

/**
 * 解析直接列出的 mod，并 BFS 展开 required 客户端依赖。
 *
 * 去重规则：
 * - spec 中同一个 project 字符串列两次 → 解析前就拒绝（parsePackSpec）；
 * - 不同写法解析到同一 project（slug 与 id）→ 拒绝；
 * - 依赖已解析为同一 project 且版本相同 → 视为已满足；版本不同 → 冲突；
 * - 依赖项目 `client_side == "unsupported"` → 跳过；直接列出的项目则报错。
 *
 * 已解析表在入队依赖前就写入，因而 A→B→A 的环依赖会命中「已满足」分支，
 * 不会无限递归；若环上要求的版本不同，则按版本冲突报错。
 */
const resolveMods = async (
  spec: ClientPackSpec,
  client: ModrinthClient,
  maxMods: number
): Promise<ClientPackMod[]> => {
  const state: ModrinthState = {
    client,
    versionLists: new Map(),
    versions: new Map(),
  };

  const resolvedByProject = new Map<string, { versionId: string; mod: ClientPackMod }>();
  const mods: ClientPackMod[] = [];
  const pending: PendingDependency[] = [];

  const addMod = (project: ProjectInfo, version: JsonRecord): void => {
    if (mods.length + 1 > maxMods) fail(`模组数量超过上限 ${maxMods}`);
    const mod = toMod(project, version);
    resolvedByProject.set(project.id, { versionId: mod.versionId, mod });
    mods.push(mod);

    for (const item of asArray(version.dependencies)) {
      const dependency = asRecord(item);
      if (dependency) pending.push({ parent: project.id, dependency });
    }
  };

  for (const rawEntry of spec.mods) {
    // parsePackSpec 已把字符串归一化；这里的判断同时让该函数对原始
    // spec 形状也安全（类型上仍是联合类型）。
    const entry: ClientPackSpecMod =
      typeof rawEntry === 'string' ? { project: rawEntry } : rawEntry;
    const project = await fetchProject(client, entry.project);
    if (project.clientSide === 'unsupported') {
      fail(`项目 ${project.id} 不支持客户端（client_side=unsupported），不能直接列入 mods`);
    }
    if (resolvedByProject.has(project.id)) fail(`模组项目重复: ${project.id}`);

    const version = await resolveVersion(state, project, entry.version, spec);
    addMod(project, version);
  }

  let index = 0;
  while (index < pending.length) {
    const { parent, dependency } = pending[index];
    index += 1;

    if (asString(dependency.dependency_type) !== 'required') continue;

    let dependencyProject = asString(dependency.project_id)?.trim() ?? '';
    const dependencyVersion = asString(dependency.version_id)?.trim() || undefined;

    // Modrinth 允许依赖只给 version_id；反查一次拿 project_id。
    if (!dependencyProject && dependencyVersion) {
      const version = await fetchVersion(state, dependencyVersion);
      dependencyProject = asString(version.project_id)?.trim() ?? '';
    }
    if (!dependencyProject) fail(`依赖缺少 project_id（来自 ${parent}）`);

    const existing = resolvedByProject.get(dependencyProject);
    if (existing) {
      if (dependencyVersion && dependencyVersion !== existing.versionId) {
        fail(
          `依赖版本冲突：${dependencyProject} 已解析为 ${existing.versionId}，` +
            `但 ${parent} 要求 ${dependencyVersion}`
        );
      }
      continue;
    }

    const project = await fetchProject(client, dependencyProject);
    if (project.clientSide === 'unsupported') continue;

    const version = await resolveVersion(state, project, dependencyVersion, spec);
    addMod(project, version);
  }

  const filenames = new Set<string>();
  for (const mod of mods) {
    if (filenames.has(mod.filename)) fail(`模组文件名重复: ${mod.filename}`);
    filenames.add(mod.filename);
  }

  return mods;
};

// ---------------------------------------------------------------- resolve

export interface ResolveClientPackOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  modrinthApiBase?: string;
  maxMods?: number;
  overridesLimits?: Partial<OverridesLimits>;
}

export interface ResolvedClientPack {
  pack: ClientPackDraft;
  overridesZip?: Buffer;
}

/** ISO 秒级时间戳；固定时钟时输出完全一致，也便于默认目录名。 */
export const formatPackCreatedAt = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export const defaultPackOutDir = (createdAt: string): string =>
  `dist/pack-${createdAt.replace(/[:.]/g, '-')}`;

export const serializeClientPackDraft = (draft: ClientPackDraft): string =>
  `${JSON.stringify(draft, null, 2)}\n`;

export const resolveClientPack = async (
  spec: ClientPackSpec,
  options: ResolveClientPackOptions = {}
): Promise<ResolvedClientPack> => {
  const maxMods = options.maxMods ?? DEFAULT_MAX_MODS;
  if (!Number.isInteger(maxMods) || maxMods < 1) fail('maxMods 不合法');

  // 接受原始 spec（mods 里的字符串尚未归一化）；重复解析是廉价的，
  // 换来的是这个函数单独调用时也做完整形状校验。
  const normalized = parsePackSpec(spec);

  const client: ModrinthClient = {
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: (
      options.modrinthApiBase ??
      normalized.modrinthApiBase ??
      DEFAULT_MODRINTH_API_BASE
    ).replace(/\/+$/, ''),
  };

  const mods = await resolveMods(normalized, client, maxMods);

  const overrides = normalized.overridesDir
    ? await buildOverridesPayload(normalized.overridesDir, options.overridesLimits)
    : null;

  const createdAt = formatPackCreatedAt((options.now ?? (() => new Date()))());

  const draft: ClientPackDraft = {
    schemaVersion: 1,
    kind: 'client-pack',
    createdAt,
    ...(normalized.notes === undefined ? {} : { notes: normalized.notes }),
    gameVersion: normalized.gameVersion,
    loader: { type: normalized.loader.type, version: normalized.loader.version },
    java:
      normalized.java.component === undefined
        ? { major: normalized.java.major }
        : { major: normalized.java.major, component: normalized.java.component },
    ...(normalized.minLauncherVersion === undefined
      ? {}
      : { minLauncherVersion: normalized.minLauncherVersion }),
    mods,
    ...(overrides ? { overrides: overrides.manifest } : {}),
  };

  // 与服务端同一套校验：发布阶段就把坏包拦住。zip 用「规范化后的清单」
  // 重新读一遍（draft 解析会 trim 路径），保证 pack.json 与 zip 条目一致，
  // 而不是只校验扫描时的原始清单。
  const pack = parseClientPackDraft(draft);
  if (overrides && pack.overrides) validateOverridesZip(overrides.zip, pack.overrides);

  return overrides ? { pack, overridesZip: overrides.zip } : { pack };
};

// ---------------------------------------------------------------- publish

export interface PublishClientPackOptions {
  token: string;
  apiBase?: string;
  overridesZip?: Buffer;
  packJson?: string;
  fetchImpl?: typeof fetch;
}

export interface PublishClientPackResult {
  packVersion: number;
  body: unknown;
}

/**
 * PUT 管理接口。用 Node 全局 FormData/Blob/fetch，不引依赖。
 * `pack` 是发布用 pack.json 的原文，`overrides` 只在有 zip 时出现。
 */
export const publishClientPack = async (
  draft: ClientPackDraft,
  options: PublishClientPackOptions
): Promise<PublishClientPackResult> => {
  const token = options.token.trim();
  if (!token) fail('发布令牌为空');

  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const packJson = options.packJson ?? serializeClientPackDraft(draft);

  const form = new FormData();
  form.set('pack', packJson);
  if (options.overridesZip && options.overridesZip.length > 0) {
    form.set(
      'overrides',
      // 复制成 Uint8Array<ArrayBuffer>，满足 BlobPart 的类型要求。
      new Blob([new Uint8Array(options.overridesZip)], { type: 'application/zip' }),
      'overrides.zip'
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/launcher/admin/client-pack`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PackPublishError(`发布请求失败: ${(error as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new PackPublishError(
      `发布失败（HTTP ${response.status}）: ${truncate(text.trim(), 300)}`
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PackPublishError('发布响应不是合法 JSON');
  }

  const packVersion = asNumber(asRecord(body)?.packVersion);
  if (packVersion === null || !Number.isInteger(packVersion) || packVersion < 1) {
    return fail('发布响应缺少 packVersion');
  }

  return { packVersion, body };
};

