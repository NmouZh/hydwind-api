import { BadRequestError, NotFoundError, UpstreamError } from './errors.ts';
import type { LauncherDeps } from './http.ts';
import { fetchText } from './http.ts';
import {
  fabricProfileUrl,
  isSafeLoaderVersion,
  quiltProfileUrl,
} from './loaders.ts';
import type { JsonRecord, NormalizedManifest, Platform } from './manifest.ts';
import {
  asString,
  isValidVersionId,
  mergeVersionJson,
  normalizeVersionJson,
} from './manifest.ts';
import type { Mirror } from './mirror.ts';
import { rewriteUrlForMirror } from './mirror.ts';
import {
  fetchVersionJson,
  fetchVersionManifest,
  sha1Hex,
  textSize,
} from './versions.ts';

/**
 * 原版 / Fabric / Quilt 的完整归一化清单。
 *
 * Fabric/Quilt profile 与 vanilla 合并规则：loader 库在前、mainClass 用
 * loader 的、arguments 父在前子在后，其余标量（assets/java/downloads）
 * 继承原版。
 */
export interface NormalizedManifestRequest {
  version: string;
  loader: 'vanilla' | 'fabric' | 'quilt';
  loaderVersion?: string;
  platform: Platform;
  mirror: Mirror;
}

export const buildNormalizedManifest = async (
  request: NormalizedManifestRequest,
  deps: LauncherDeps
): Promise<NormalizedManifest> => {
  if (!isValidVersionId(request.version)) throw new NotFoundError('非法版本 id');

  if (request.loader === 'vanilla') {
    const vanilla = await fetchVersionJson(request.version, deps, request.mirror);
    return normalizeVersionJson(vanilla.raw, {
      platform: request.platform,
      mirror: request.mirror,
      id: request.version,
      gameVersion: request.version,
      loader: null,
      versionJsonFile: {
        url: vanilla.entry.url,
        sha1: vanilla.entry.sha1 || sha1Hex(vanilla.text),
        size: textSize(vanilla.text),
      },
    });
  }

  const loaderVersion = request.loaderVersion?.trim() ?? '';
  if (!loaderVersion || !isSafeLoaderVersion(loaderVersion)) {
    throw new BadRequestError('缺少或非法的 loaderVersion');
  }

  const [vanilla, profile] = await Promise.all([
    fetchVersionJson(request.version, deps, request.mirror),
    fetchLoaderProfile(request.loader, request.version, loaderVersion, deps, request.mirror),
  ]);

  const inheritsFrom = asString(profile.raw.inheritsFrom);
  if (inheritsFrom && inheritsFrom !== request.version) {
    throw new UpstreamError(
      `${request.loader} profile 的 inheritsFrom (${inheritsFrom}) 与请求版本不一致`
    );
  }

  const merged = mergeVersionJson(vanilla.raw, profile.raw);
  const profileId = asString(profile.raw.id);
  const id =
    profileId && isValidVersionId(profileId)
      ? profileId
      : `${request.loader}-loader-${loaderVersion}-${request.version}`;

  return normalizeVersionJson(merged, {
    platform: request.platform,
    mirror: request.mirror,
    id,
    gameVersion: request.version,
    loader: { type: request.loader, version: loaderVersion },
    versionJsonFile: {
      url: profile.url,
      sha1: sha1Hex(profile.text),
      size: textSize(profile.text),
    },
  });
};

interface LoaderProfile {
  raw: JsonRecord;
  text: string;
  url: string;
}

const parseProfile = (text: string, url: string): LoaderProfile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError('loader profile 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UpstreamError('loader profile 不是对象');
  }
  return { raw: parsed as JsonRecord, text, url };
};

const fetchLoaderProfile = async (
  loader: 'fabric' | 'quilt',
  gameVersion: string,
  loaderVersion: string,
  deps: LauncherDeps,
  mirror: Mirror
): Promise<LoaderProfile> => {
  const official =
    loader === 'fabric'
      ? fabricProfileUrl(gameVersion, loaderVersion)
      : quiltProfileUrl(gameVersion, loaderVersion);
  const mirrored = rewriteUrlForMirror(official, mirror);

  // BMCLAPI 目前只镜像 Fabric meta；Quilt per-game profile 会 404，
  // 因此镜像优先、官方兜底。缓存 key 包含实际 URL，避免串味。
  const candidates =
    mirrored !== official ? [mirrored, official] : [official];
  let lastError: unknown = new UpstreamError('loader profile 获取失败');

  for (const url of candidates) {
    try {
      const result = await fetchText(url, deps, {
        ttlMs: 10 * 60 * 1000,
        cacheKey: `launcher:loader-profile:${loader}:${gameVersion}:${loaderVersion}:${url}`,
        notFoundStatus: true,
      });
      return parseProfile(result.text, url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

/** GET /api/launcher/versions 的响应形状。 */
export const listMinecraftVersions = async (deps: LauncherDeps): Promise<{
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; releaseTime: string }[];
}> => {
  const manifest = await fetchVersionManifest(deps);
  return {
    latest: manifest.latest,
    versions: manifest.versions.map((entry) => ({
      id: entry.id,
      type: entry.type,
      releaseTime: entry.releaseTime,
    })),
  };
};
