import { BadRequestError, NotFoundError, UpstreamError } from './errors.ts';
import type { LauncherDeps } from './http.ts';
import { fetchJson, fetchText } from './http.ts';
import type { JsonRecord } from './manifest.ts';
import { asRecord, asString, isValidVersionId } from './manifest.ts';

/**
 * Fabric / Quilt / Forge / NeoForge 版本列表。
 *
 * 每个 loader 都只返回与 `gameVersion` 兼容的版本：
 * - Fabric/Quilt：meta 的 per-game 端点本身就是兼容列表；
 * - Forge：maven-metadata 过滤 `${gameVersion}-` 前缀，promotions_slim 标记 stable；
 * - NeoForge：maven-metadata 过滤版本号映射（21.5.75 → 1.21.5，26.3.0.115 → 26.3）。
 */

export interface LoaderVersion {
  version: string;
  stable?: boolean;
  url?: string;
}

export interface LoaderBundle {
  gameVersion: string;
  loaders: {
    fabric: LoaderVersion[];
    quilt: LoaderVersion[];
    forge: LoaderVersion[];
    neoforge: LoaderVersion[];
  };
}

export const LOADER_METADATA_TTL_MS = 10 * 60 * 1000;

export const FABRIC_META = 'https://meta.fabricmc.net';
export const QUILT_META = 'https://meta.quiltmc.org';
export const FORGE_MAVEN = 'https://maven.minecraftforge.net';
export const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';

export const isSafeLoaderVersion = (value: string): boolean =>
  /^[A-Za-z0-9._+\-]{1,64}$/.test(value);

export const fabricProfileUrl = (gameVersion: string, loaderVersion: string): string =>
  `${FABRIC_META}/v2/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(
    loaderVersion
  )}/profile/json`;

export const quiltProfileUrl = (gameVersion: string, loaderVersion: string): string =>
  `${QUILT_META}/v3/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(
    loaderVersion
  )}/profile/json`;

export const forgeInstallerUrl = (gameVersion: string, forgeVersion: string): string => {
  const fullVersion = `${gameVersion}-${forgeVersion}`;
  return `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
};

export const neoForgeArtifact = (
  gameVersion: string
): { artifact: 'forge' | 'neoforge'; coordinateVersion: (version: string) => string } =>
  gameVersion === '1.20.1'
    ? { artifact: 'forge', coordinateVersion: (version) => `${gameVersion}-${version}` }
    : { artifact: 'neoforge', coordinateVersion: (version) => version };

export const neoForgeInstallerUrl = (
  gameVersion: string,
  neoForgeVersion: string
): string => {
  const { artifact, coordinateVersion } = neoForgeArtifact(gameVersion);
  const version = coordinateVersion(neoForgeVersion);
  return `${NEOFORGE_MAVEN}/net/neoforged/${artifact}/${version}/${artifact}-${version}-installer.jar`;
};

/** NeoForge 版本号 → 是否属于该 MC 版本。 */
export const neoforgeVersionMatches = (version: string, gameVersion: string): boolean => {
  if (version.startsWith(`${gameVersion}-`) || version.startsWith(`${gameVersion}.`)) return true;

  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!gameVersion.startsWith('1.')) return false;

  const candidate = minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
  return candidate === gameVersion;
};

const versionTokens = (value: string): (number | string)[] => {
  const tokens: (number | string)[] = [];
  for (const part of value.split(/[.\-+_]/)) {
    if (!part) continue;
    if (/^\d+$/.test(part)) tokens.push(Number(part));
    else tokens.push(part.toLowerCase());
  }
  return tokens;
};

/** 语义化数字比较，降序（新 → 旧）；`1.0.0` 排在 `1.0.0-beta.1` 前。 */
export const compareVersionsDesc = (a: string, b: string): number => {
  const left = versionTokens(a);
  const right = versionTokens(b);
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return y - x;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? 1 : -1;
  }

  // 前缀相同：正式版（段数更少）排在预发布版前面。
  return left.length - right.length;
};

export const sortLoaderVersions = (versions: LoaderVersion[]): LoaderVersion[] =>
  [...versions].sort((a, b) => compareVersionsDesc(a.version, b.version));

export const parseMavenMetadataVersions = (xml: string): string[] => {
  const versions: string[] = [];
  const pattern = /<version>([^<]+)<\/version>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const version = match[1].trim();
    if (isSafeLoaderVersion(version)) versions.push(version);
  }
  return versions;
};

const fetchLoaderList = async (
  url: string,
  cacheKey: string,
  deps: LauncherDeps
): Promise<unknown[]> => {
  try {
    const result = await fetchJson(url, deps, {
      ttlMs: LOADER_METADATA_TTL_MS,
      cacheKey,
      notFoundStatus: true,
    });
    if (!Array.isArray(result.data)) throw new UpstreamError('loader 元数据不是数组');
    return result.data;
  } catch (error) {
    // 未知游戏版本时 meta 返回 404；把它当成空列表，而不是网关故障。
    if (error instanceof NotFoundError) return [];
    throw error;
  }
};

const fabricLoaders = async (gameVersion: string, deps: LauncherDeps): Promise<LoaderVersion[]> => {
  const url = `${FABRIC_META}/v2/versions/loader/${encodeURIComponent(gameVersion)}`;
  const list = await fetchLoaderList(url, `launcher:fabric:${gameVersion}`, deps);

  const versions: LoaderVersion[] = [];
  for (const item of list) {
    const root = asRecord(item);
    const loader = asRecord(root?.loader);
    const version = asString(loader?.version);
    if (!version || !isSafeLoaderVersion(version)) continue;
    const entry: LoaderVersion = {
      version,
      url: fabricProfileUrl(gameVersion, version),
    };
    if (typeof loader?.stable === 'boolean') entry.stable = loader.stable;
    versions.push(entry);
  }
  return sortLoaderVersions(versions);
};

const quiltLoaders = async (gameVersion: string, deps: LauncherDeps): Promise<LoaderVersion[]> => {
  const url = `${QUILT_META}/v3/versions/loader/${encodeURIComponent(gameVersion)}`;
  const list = await fetchLoaderList(url, `launcher:quilt:${gameVersion}`, deps);

  const versions: LoaderVersion[] = [];
  for (const item of list) {
    const root = asRecord(item);
    const loader = asRecord(root?.loader);
    const version = asString(loader?.version);
    if (!version || !isSafeLoaderVersion(version)) continue;
    versions.push({
      version,
      stable: !/[-\+](alpha|beta|pre|rc|snapshot)/i.test(version) && !version.includes('-'),
      url: quiltProfileUrl(gameVersion, version),
    });
  }
  return sortLoaderVersions(versions);
};

interface ForgePromotions {
  latest: string | null;
  recommended: string | null;
}

const fetchForgePromotions = async (
  gameVersion: string,
  deps: LauncherDeps
): Promise<ForgePromotions> => {
  const result = await fetchJson<JsonRecord>(FORGE_PROMOTIONS_URL, deps, {
    ttlMs: LOADER_METADATA_TTL_MS,
    cacheKey: 'launcher:forge:promotions',
  });
  const promos = asRecord(result.data.promos);
  return {
    latest: asString(promos?.[`${gameVersion}-latest`]),
    recommended: asString(promos?.[`${gameVersion}-recommended`]),
  };
};

const forgeLoaders = async (gameVersion: string, deps: LauncherDeps): Promise<LoaderVersion[]> => {
  const promotions = await fetchForgePromotions(gameVersion, deps);

  let metadataVersions: string[] = [];
  try {
    const result = await fetchText(
      `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`,
      deps,
      {
        ttlMs: LOADER_METADATA_TTL_MS,
        cacheKey: 'launcher:forge:maven-metadata',
      }
    );
    metadataVersions = parseMavenMetadataVersions(result.text);
  } catch (error) {
    // 官方元数据偶发超时：至少保留 promotions 里的 latest/recommended。
    if (!(error instanceof UpstreamError)) throw error;
  }

  const stableSet = new Set(
    [promotions.latest, promotions.recommended].filter((value): value is string => !!value)
  );
  const versions = new Map<string, LoaderVersion>();

  for (const full of metadataVersions) {
    if (!full.startsWith(`${gameVersion}-`)) continue;
    const version = full.slice(gameVersion.length + 1);
    if (!version || !isSafeLoaderVersion(version)) continue;
    const entry: LoaderVersion = {
      version,
      url: forgeInstallerUrl(gameVersion, version),
    };
    if (stableSet.has(version)) entry.stable = true;
    versions.set(version, entry);
  }

  for (const version of stableSet) {
    if (!versions.has(version)) {
      versions.set(version, {
        version,
        stable: true,
        url: forgeInstallerUrl(gameVersion, version),
      });
    }
  }

  return sortLoaderVersions([...versions.values()]);
};

const neoForgeMetadataUrl = (gameVersion: string, mirror: boolean): string => {
  const { artifact } = neoForgeArtifact(gameVersion);
  const path = `net/neoforged/${artifact}/maven-metadata.xml`;
  return mirror
    ? `https://bmclapi2.bangbang93.com/maven/${path}`
    : `${NEOFORGE_MAVEN}/${path}`;
};

const neoForgeLoaders = async (
  gameVersion: string,
  deps: LauncherDeps
): Promise<LoaderVersion[]> => {
  let xml: string;
  try {
    xml = (
      await fetchText(neoForgeMetadataUrl(gameVersion, false), deps, {
        ttlMs: LOADER_METADATA_TTL_MS,
        cacheKey: `launcher:neoforge:metadata:${gameVersion}`,
        timeoutMs: 8_000,
      })
    ).text;
  } catch (error) {
    // 官方 Maven 在部分网络不可达；BMCLAPI 的 /maven 有完整元数据。
    if (!(error instanceof UpstreamError)) throw error;
    xml = (
      await fetchText(neoForgeMetadataUrl(gameVersion, true), deps, {
        ttlMs: LOADER_METADATA_TTL_MS,
        cacheKey: `launcher:neoforge:metadata:${gameVersion}:bmclapi`,
        timeoutMs: 20_000,
      })
    ).text;
  }

  const { artifact } = neoForgeArtifact(gameVersion);
  const versions = new Map<string, LoaderVersion>();

  for (const full of parseMavenMetadataVersions(xml)) {
    const version = artifact === 'forge' ? full.replace(`${gameVersion}-`, '') : full;
    if (!neoforgeVersionMatches(full, gameVersion)) continue;
    if (!version || !isSafeLoaderVersion(version)) continue;
    if (versions.has(version)) continue;

    const entry: LoaderVersion = {
      version,
      url: neoForgeInstallerUrl(gameVersion, version),
    };
    if (!/(alpha|beta|pre|rc|snapshot)/i.test(full)) entry.stable = true;
    versions.set(version, entry);
  }

  return sortLoaderVersions([...versions.values()]);
};

export const buildLoaderVersions = async (
  gameVersion: string,
  deps: LauncherDeps
): Promise<LoaderBundle> => {
  if (!isValidVersionId(gameVersion)) {
    throw new BadRequestError('非法 gameVersion');
  }

  const [fabric, quilt, forge, neoforge] = await Promise.all([
    fabricLoaders(gameVersion, deps),
    quiltLoaders(gameVersion, deps),
    forgeLoaders(gameVersion, deps),
    neoForgeLoaders(gameVersion, deps),
  ]);

  return { gameVersion, loaders: { fabric, quilt, forge, neoforge } };
};
