import { createHash } from 'node:crypto';
import { NotFoundError, ManifestError, UpstreamError } from './errors.ts';
import type { LauncherDeps } from './http.ts';
import { fetchJson, fetchText } from './http.ts';
import type { JsonRecord, Mirror } from './manifest.ts';
import {
  asArray,
  asRecord,
  asString,
  isValidVersionId,
  mergeVersionJson,
} from './manifest.ts';
import { rewriteUrlForMirror } from './mirror.ts';

/**
 * Mojang 版本清单与版本 JSON 的读取/继承解析。
 *
 * 所有版本 JSON 都按 id 从官方 manifest 反查 URL，绝不接受调用方给出的
 * 任意 URL；`inheritsFrom` 因而天然被限制在 Mojang 已发布版本内。
 */
export const VERSION_MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

export const VERSION_MANIFEST_TTL_MS = 10 * 60 * 1000;
export const VERSION_JSON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INHERITANCE_DEPTH = 10;

export interface VersionEntry {
  id: string;
  type: string;
  url: string;
  sha1: string;
  releaseTime: string;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionEntry[];
}

const parseManifest = (value: unknown): VersionManifest => {
  const root = asRecord(value);
  const latest = asRecord(root?.latest);
  const release = asString(latest?.release);
  const snapshot = asString(latest?.snapshot);
  if (!root || !release || !snapshot) {
    throw new UpstreamError('Mojang 版本清单格式不合法');
  }

  const versions: VersionEntry[] = [];
  for (const item of asArray(root.versions)) {
    const entry = asRecord(item);
    const id = asString(entry?.id);
    const type = asString(entry?.type);
    const url = asString(entry?.url);
    if (!id || !type || !url) continue;
    versions.push({
      id,
      type,
      url,
      sha1: asString(entry?.sha1) ?? '',
      releaseTime: asString(entry?.releaseTime) ?? '',
    });
  }

  if (versions.length === 0) throw new UpstreamError('Mojang 版本清单为空');
  return { latest: { release, snapshot }, versions };
};

export const fetchVersionManifest = async (deps: LauncherDeps): Promise<VersionManifest> => {
  const result = await fetchJson(VERSION_MANIFEST_URL, deps, {
    ttlMs: VERSION_MANIFEST_TTL_MS,
    cacheKey: 'launcher:version-manifest',
  });
  return parseManifest(result.data);
};

export const findVersionEntry = (
  manifest: VersionManifest,
  id: string
): VersionEntry | null => manifest.versions.find((entry) => entry.id === id) ?? null;

export const sha1Hex = (text: string): string =>
  createHash('sha1').update(text, 'utf8').digest('hex');

export interface VersionJsonResult {
  entry: VersionEntry;
  raw: JsonRecord;
  text: string;
  url: string;
}

const parseVersionJson = (text: string, id: string): JsonRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError(`版本 JSON 不是合法 JSON: ${id}`);
  }
  const raw = asRecord(parsed);
  if (!raw) throw new UpstreamError(`版本 JSON 不是对象: ${id}`);
  return raw;
};

/**
 * 按 id 读取版本 JSON（长缓存 7 天）。BMCLAPI 模式用同路径镜像；
 * 缓存 key 包含镜像，避免把官方响应误当成镜像响应。
 */
export const fetchVersionJson = async (
  id: string,
  deps: LauncherDeps,
  mirror: Mirror
): Promise<VersionJsonResult> => {
  if (!isValidVersionId(id)) throw new NotFoundError('非法版本 id');

  const manifest = await fetchVersionManifest(deps);
  const entry = findVersionEntry(manifest, id);
  if (!entry) throw new NotFoundError(`未知 Mojang 版本: ${id}`);

  const url = rewriteUrlForMirror(entry.url, mirror);
  const result = await fetchText(url, deps, {
    ttlMs: VERSION_JSON_TTL_MS,
    cacheKey: `launcher:version-json:${mirror}:${id}:${entry.sha1}`,
  });

  return { entry, raw: parseVersionJson(result.text, id), text: result.text, url };
};

export interface InheritanceResult {
  merged: JsonRecord;
  rootId: string;
  depth: number;
}

/**
 * 递归合并 `inheritsFrom`。
 *
 * - 父版本必须存在于 Mojang manifest；
 * - 循环、超深（>10）、非法 id 都拒绝；
 * - `rootId` 是最深层的原版版本 id，用作 `gameVersion`。
 */
export const resolveInheritance = async (
  raw: JsonRecord,
  deps: LauncherDeps,
  mirror: Mirror,
  maxDepth = MAX_INHERITANCE_DEPTH
): Promise<InheritanceResult> => {
  const id = asString(raw.id);
  if (!id || !isValidVersionId(id)) throw new ManifestError('版本 JSON 的 id 不合法');

  let current = raw;
  let currentId = id;
  let rootId = id;
  let depth = 0;
  const visited = new Set<string>([id]);
  let parentId = asString(raw.inheritsFrom);

  while (parentId !== null) {
    if (!isValidVersionId(parentId)) {
      throw new ManifestError('inheritsFrom 字符集不合法');
    }
    if (visited.has(parentId)) throw new ManifestError('inheritsFrom 存在循环');
    if (depth >= maxDepth) throw new ManifestError('inheritsFrom 层级过深');

    const manifest = await fetchVersionManifest(deps);
    const entry = findVersionEntry(manifest, parentId);
    if (!entry) throw new ManifestError(`inheritsFrom 不是合法 Mojang 版本: ${parentId}`);

    const parent = await fetchVersionJson(parentId, deps, mirror);
    current = mergeVersionJson(parent.raw, current);
    currentId = parentId;
    rootId = parentId;
    visited.add(parentId);
    depth += 1;

    parentId = asString(parent.raw.inheritsFrom);
  }

  if (!currentId) throw new ManifestError('无法确定版本 id');
  return { merged: current, rootId, depth };
};

/** 版本 JSON 大小（字节），用于 `version-json` 文件条目。 */
export const textSize = (text: string): number => Buffer.byteLength(text, 'utf8');

/** 便于 live 脚本复用的 manifest 摘要。 */
export const summarizeManifest = (manifest: VersionManifest): {
  latest: { release: string; snapshot: string };
  count: number;
  first: string[];
} => ({
  latest: manifest.latest,
  count: manifest.versions.length,
  first: manifest.versions.slice(0, 3).map((entry) => entry.id),
});
