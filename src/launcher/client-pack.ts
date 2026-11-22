import { createHash } from 'node:crypto';
import { BadRequestError } from './errors.ts';
import { asArray, asNumber, asRecord, asString, isValidVersionId } from './manifest.ts';
import type { LoaderType } from './manifest.ts';
import { readZipEntries } from './zip.ts';
import type { ZipReadLimits } from './zip.ts';

/**
 * 服务器权威客户端包。
 *
 * 包文档由发布脚本生成、管理接口写入；启动器只读。所有字段都在这里校验，
 * 避免「发布时没拦住、安装时才炸」。
 */

export type ClientLoaderType = Exclude<LoaderType, 'vanilla'>;

export interface ClientPackMod {
  projectId: string;
  versionId: string;
  name: string;
  versionNumber: string;
  filename: string;
  url: string;
  sha512: string;
  size: number;
}

export interface ClientPackOverridesFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ClientPackDraftOverrides {
  sha256: string;
  size: number;
  files: ClientPackOverridesFile[];
}

export interface ClientPackOverrides extends ClientPackDraftOverrides {
  url: string;
}

export interface ClientPackDraft {
  schemaVersion: 1;
  kind: 'client-pack';
  createdAt: string;
  notes?: string;
  gameVersion: string;
  loader: { type: ClientLoaderType; version: string };
  java: { major: number; component?: string };
  minLauncherVersion?: string;
  mods: ClientPackMod[];
  overrides?: ClientPackDraftOverrides;
}

export interface ClientPack extends ClientPackDraft {
  packVersion: number;
  overrides?: ClientPackOverrides;
}

const LOADER_TYPES = new Set<ClientLoaderType>(['fabric', 'quilt', 'forge', 'neoforge']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA512_PATTERN = /^[a-f0-9]{128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIN_LAUNCHER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_MODS = 200;
const MAX_MOD_BYTES = 512 * 1024 * 1024;
const MAX_OVERRIDE_FILES = 2_000;
export const MAX_OVERRIDES_BYTES = 50 * 1024 * 1024;
const MAX_NOTES = 500;
const MAX_PATH = 240;

/**
 * overrides 合同的 zip 读取上限：单条目与解压总量都放宽到 50 MiB，
 * 条目数与清单上限一致；文本配置的压缩比可以很高，单独放宽。
 */
const OVERRIDES_ZIP_LIMITS: ZipReadLimits = {
  maxEntries: MAX_OVERRIDE_FILES,
  maxTotalUncompressed: MAX_OVERRIDES_BYTES,
  maxEntryUncompressed: MAX_OVERRIDES_BYTES,
  maxCompressionRatio: 10_000,
};

const fail = (message: string): never => {
  throw new BadRequestError(message);
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  const record = asRecord(value);
  if (!record) fail(`${label} 必须是对象`);
  return record;
};

const requireString = (value: unknown, label: string, max = 200): string => {
  const text = asString(value)?.trim() ?? '';
  if (!text || text.length > max) fail(`${label} 不合法`);
  return text;
};

const requireInt = (value: unknown, label: string, min: number, max: number): number => {
  const number = asNumber(value);
  if (number === null || !Number.isInteger(number) || number < min || number > max) {
    fail(`${label} 不合法`);
  }
  return number;
};

const requireHex = (value: unknown, pattern: RegExp, label: string): string => {
  const text = asString(value)?.trim().toLowerCase() ?? '';
  if (!pattern.test(text)) fail(`${label} 不合法`);
  return text;
};

export const isSafeRelativePath = (value: string): boolean => {
  if (!value || value.length > MAX_PATH) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
};

export const isSafeFilename = (value: string): boolean => {
  if (!value || value.length > 200) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  if (value === '.' || value === '..') return false;
  return !/[\u0000-\u001f]/.test(value);
};

const parseMod = (value: unknown, index: number): ClientPackMod => {
  const label = `mods[${index}]`;
  const record = requireRecord(value, label);

  const projectId = requireString(record.projectId, `${label}.projectId`, 64);
  if (!ID_PATTERN.test(projectId)) fail(`${label}.projectId 不合法`);

  const versionId = requireString(record.versionId, `${label}.versionId`, 64);
  if (!ID_PATTERN.test(versionId)) fail(`${label}.versionId 不合法`);

  const name = requireString(record.name, `${label}.name`, 100);
  const versionNumber = requireString(record.versionNumber, `${label}.versionNumber`, 64);

  const filename = requireString(record.filename, `${label}.filename`, 200);
  if (!isSafeFilename(filename)) fail(`${label}.filename 不合法`);

  const url = requireString(record.url, `${label}.url`, 500);
  const parsedUrl = (() => {
    try {
      return new URL(url);
    } catch {
      return fail(`${label}.url 不合法`);
    }
  })();
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'cdn.modrinth.com') {
    fail(`${label}.url 必须是 cdn.modrinth.com 的 HTTPS 地址`);
  }

  const sha512 = requireHex(record.sha512, SHA512_PATTERN, `${label}.sha512`);
  const size = requireInt(record.size, `${label}.size`, 1, MAX_MOD_BYTES);

  return { projectId, versionId, name, versionNumber, filename, url, sha512, size };
};

/** 解析选项：只有读取已存包时才允许服务端生成字段。 */
export interface ParseClientPackOptions {
  allowServerFields?: boolean;
}

const parseOverridesDraft = (
  value: unknown,
  options: ParseClientPackOptions
): ClientPackDraftOverrides => {
  const record = requireRecord(value, 'overrides');
  if (!options.allowServerFields && record.url !== undefined) {
    fail('overrides.url 由服务端生成，pack 输入不能包含');
  }
  const sha256 = requireHex(record.sha256, SHA256_PATTERN, 'overrides.sha256');
  const size = requireInt(record.size, 'overrides.size', 0, MAX_OVERRIDES_BYTES);

  const files = asArray(record.files);
  if (files.length === 0 || files.length > MAX_OVERRIDE_FILES) {
    fail('overrides.files 数量不合法');
  }

  const seen = new Set<string>();
  let total = 0;
  const parsed = files.map((item, index) => {
    const label = `overrides.files[${index}]`;
    const file = requireRecord(item, label);
    const path = requireString(file.path, `${label}.path`, MAX_PATH);
    if (!isSafeRelativePath(path)) fail(`${label}.path 不合法`);
    if (seen.has(path)) fail(`${label}.path 重复`);
    seen.add(path);

    const fileSha256 = requireHex(file.sha256, SHA256_PATTERN, `${label}.sha256`);
    const fileSize = requireInt(file.size, `${label}.size`, 0, MAX_OVERRIDES_BYTES);
    total += fileSize;
    return { path, sha256: fileSha256, size: fileSize };
  });

  if (total > MAX_OVERRIDES_BYTES) fail('overrides 解压后总量过大');

  return { sha256, size, files: parsed.sort((left, right) => left.path.localeCompare(right.path)) };
};

export const parseClientPackDraft = (
  value: unknown,
  options: ParseClientPackOptions = {}
): ClientPackDraft => {
  const record = requireRecord(value, 'pack');
  if (!options.allowServerFields && record.packVersion !== undefined) {
    fail('packVersion 由服务端生成，pack 输入不能包含');
  }
  if (record.schemaVersion !== 1) fail('schemaVersion 必须是 1');
  if (record.kind !== 'client-pack') fail('kind 必须是 client-pack');

  const createdAt = requireString(record.createdAt, 'createdAt', 40);
  if (Number.isNaN(Date.parse(createdAt))) fail('createdAt 不是合法时间');

  const notesValue = record.notes;
  const notes = notesValue === undefined ? undefined : requireString(notesValue, 'notes', MAX_NOTES);

  const gameVersion = requireString(record.gameVersion, 'gameVersion', 64);
  if (!isValidVersionId(gameVersion)) fail('gameVersion 不合法');

  const loader = requireRecord(record.loader, 'loader');
  const type = requireString(loader.type, 'loader.type', 16) as ClientLoaderType;
  if (!LOADER_TYPES.has(type)) fail('loader.type 不合法');
  const loaderVersion = requireString(loader.version, 'loader.version', 64);
  if (!isValidVersionId(loaderVersion)) fail('loader.version 不合法');

  const java = requireRecord(record.java, 'java');
  const major = requireInt(java.major, 'java.major', 1, 99);
  const componentValue = java.component;
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

  const modsRaw = asArray(record.mods);
  if (modsRaw.length > MAX_MODS) fail('mods 数量过多');
  const mods = modsRaw.map((item, index) => parseMod(item, index));

  const filenames = new Set<string>();
  const projectIds = new Set<string>();
  for (const mod of mods) {
    if (filenames.has(mod.filename)) fail(`模组文件名重复: ${mod.filename}`);
    if (projectIds.has(mod.projectId)) fail(`模组项目重复: ${mod.projectId}`);
    filenames.add(mod.filename);
    projectIds.add(mod.projectId);
  }

  const overrides =
    record.overrides === undefined
      ? undefined
      : parseOverridesDraft(record.overrides, options);

  return {
    schemaVersion: 1,
    kind: 'client-pack',
    createdAt,
    notes,
    gameVersion,
    loader: { type, version: loaderVersion },
    java: { major, component },
    minLauncherVersion,
    mods,
    overrides,
  };
};

export const clientPackOverridesUrl = (packVersion: number): string =>
  `/api/launcher/client/overrides/${packVersion}`;

/** 补上服务端字段并固定 JSON 键顺序，保证落盘字节稳定、便于人工审阅。 */
export const finalizeClientPack = (draft: ClientPackDraft, packVersion: number): ClientPack => ({
  schemaVersion: draft.schemaVersion,
  kind: draft.kind,
  packVersion,
  createdAt: draft.createdAt,
  notes: draft.notes,
  gameVersion: draft.gameVersion,
  loader: draft.loader,
  java: draft.java,
  minLauncherVersion: draft.minLauncherVersion,
  mods: draft.mods,
  overrides: draft.overrides
    ? {
        url: clientPackOverridesUrl(packVersion),
        sha256: draft.overrides.sha256,
        size: draft.overrides.size,
        files: draft.overrides.files,
      }
    : undefined,
});

/** 读取已存包：允许 packVersion / overrides.url，未知字段直接忽略（阶段 D 预留）。 */
export const parseStoredClientPack = (value: unknown): ClientPack => {
  const record = requireRecord(value, 'pack');
  const draft = parseClientPackDraft(record, { allowServerFields: true });
  const packVersion = requireInt(record.packVersion, 'packVersion', 1, Number.MAX_SAFE_INTEGER);

  if (draft.overrides) {
    const overrides = requireRecord(record.overrides, 'overrides');
    const url = requireString(overrides.url, 'overrides.url', 200);
    if (url !== clientPackOverridesUrl(packVersion)) {
      fail('overrides.url 与 packVersion 不一致');
    }
  }

  return finalizeClientPack(draft, packVersion);
};

export const sha256Hex = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

export const packEtag = (raw: string): string => sha256Hex(raw);

export const matchesEtag = (header: string, etag: string): boolean =>
  header
    .split(',')
    .map((part) => part.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .some((part) => part === etag);

/** 校验 overrides.zip 与包内逐文件清单完全一致；zip-slip 由 readZipEntries 拒绝。 */
export const validateOverridesZip = (
  zip: Buffer,
  overrides: ClientPackDraftOverrides
): void => {
  if (zip.length !== overrides.size) fail('overrides.zip 大小与清单不一致');
  if (sha256Hex(zip) !== overrides.sha256) fail('overrides.zip 哈希与清单不一致');

  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(zip, OVERRIDES_ZIP_LIMITS);
  } catch (error) {
    fail(`overrides.zip 不合法：${(error as Error).message}`);
  }

  if (entries.size !== overrides.files.length) {
    fail('overrides.zip 条目数量与清单不一致');
  }

  for (const file of overrides.files) {
    const content = entries.get(file.path);
    if (!content) fail(`overrides.zip 缺少 ${file.path}`);
    if (content.length !== file.size) fail(`overrides.zip 中 ${file.path} 大小不一致`);
    if (sha256Hex(content) !== file.sha256) fail(`overrides.zip 中 ${file.path} 哈希不一致`);
  }
};