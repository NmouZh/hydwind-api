import { BadRequestError, NotFoundError, UpstreamError } from './errors.ts';
import type { LauncherDeps } from './http.ts';
import { fetchJson } from './http.ts';
import type { JsonRecord } from './manifest.ts';
import { asArray, asNumber, asRecord, asString } from './manifest.ts';

/**
 * Modrinth v2 代理。
 *
 * 搜索的 facets 由服务端拼装，调用方不需要懂 Modrinth 的查询语法；
 * modpack 端点只返回主文件（`primary: true`），避免启动器把 sources jar
 * 当成整合包下载。响应缓存 5 分钟，User-Agent 来自配置。
 */
export const MODRINTH_API = 'https://api.modrinth.com/v2';
export const MODRINTH_TTL_MS = 5 * 60 * 1000;

const PROJECT_TYPES = new Set(['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'plugin']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GAME_VERSION_PATTERN = /^[A-Za-z0-9._+\-]{1,32}$/;
const LOADER_PATTERN = /^[A-Za-z0-9._\-]{1,32}$/;

const modrinthFetch = async (
  url: string,
  deps: LauncherDeps,
  notFoundStatus = false
): Promise<unknown> => {
  const result = await fetchJson(url, deps, {
    ttlMs: MODRINTH_TTL_MS,
    cacheKey: `launcher:modrinth:${url}`,
    headers: {
      'user-agent': deps.modrinthUserAgent,
      accept: 'application/json',
    },
    notFoundStatus,
  });
  return result.data;
};

export interface ModrinthSearchParams {
  query?: string | null;
  projectType?: string | null;
  gameVersion?: string | null;
  loader?: string | null;
  limit?: string | null;
  offset?: string | null;
}

export interface ParsedSearch {
  url: string;
}

const parseInteger = (
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number
): number | null => {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
};

export const buildModrinthSearchUrl = (
  params: ModrinthSearchParams
): ParsedSearch | { error: string } => {
  const query = (params.query ?? '').trim();
  if (query.length > 100) return { error: 'query 过长' };

  const projectType = (params.projectType ?? '').trim();
  if (projectType && !PROJECT_TYPES.has(projectType)) {
    return { error: '不支持的 projectType' };
  }

  const gameVersion = (params.gameVersion ?? '').trim();
  if (gameVersion && !GAME_VERSION_PATTERN.test(gameVersion)) {
    return { error: '非法 gameVersion' };
  }

  const loader = (params.loader ?? '').trim().toLowerCase();
  if (loader && !LOADER_PATTERN.test(loader)) return { error: '非法 loader' };

  const limit = parseInteger(params.limit, 20, 1, 100);
  if (limit === null) return { error: 'limit 必须是 1-100 的整数' };

  const offset = parseInteger(params.offset, 0, 0, 100_000);
  if (offset === null) return { error: 'offset 必须是 0-100000 的整数' };

  const facets: string[][] = [];
  if (projectType) facets.push([`project_type:${projectType}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const search = new URLSearchParams();
  if (query) search.set('query', query);
  if (facets.length > 0) search.set('facets', JSON.stringify(facets));
  search.set('limit', String(limit));
  search.set('offset', String(offset));

  return { url: `${MODRINTH_API}/search?${search.toString()}` };
};

export const searchModrinth = async (
  params: ModrinthSearchParams,
  deps: LauncherDeps
): Promise<unknown> => {
  const parsed = buildModrinthSearchUrl(params);
  if ('error' in parsed) throw new BadRequestError(parsed.error);

  const data = await modrinthFetch(parsed.url, deps);
  if (!asRecord(data)) throw new UpstreamError('Modrinth 搜索响应不是对象');
  return data;
};

export const getModrinthProject = async (
  idOrSlug: string,
  deps: LauncherDeps
): Promise<unknown> => {
  if (!ID_PATTERN.test(idOrSlug)) throw new NotFoundError('非法项目 id');
  const data = await modrinthFetch(
    `${MODRINTH_API}/project/${encodeURIComponent(idOrSlug)}`,
    deps,
    true
  );
  if (!asRecord(data)) throw new UpstreamError('Modrinth 项目响应不是对象');
  return data;
};

export interface ProjectVersionFilters {
  gameVersion?: string | null;
  loader?: string | null;
}

/**
 * 项目版本列表。
 *
 * Modrinth 的端点名是单数 `/version`，且不接受 game_versions/loaders 过滤；
 * 这里取回全部版本后按字段过滤，缓存的是未过滤的完整列表。
 */
export const listModrinthVersions = async (
  idOrSlug: string,
  filters: ProjectVersionFilters,
  deps: LauncherDeps
): Promise<unknown[]> => {
  if (!ID_PATTERN.test(idOrSlug)) throw new NotFoundError('非法项目 id');

  const gameVersion = (filters.gameVersion ?? '').trim();
  if (gameVersion && !GAME_VERSION_PATTERN.test(gameVersion)) {
    throw new BadRequestError('非法 gameVersion');
  }
  const loader = (filters.loader ?? '').trim().toLowerCase();
  if (loader && !LOADER_PATTERN.test(loader)) throw new BadRequestError('非法 loader');

  const data = await modrinthFetch(
    `${MODRINTH_API}/project/${encodeURIComponent(idOrSlug)}/version`,
    deps,
    true
  );
  if (!Array.isArray(data)) throw new UpstreamError('Modrinth 版本列表不是数组');

  if (!gameVersion && !loader) return data;

  return data.filter((item) => {
    const version = asRecord(item);
    if (!version) return false;
    if (gameVersion) {
      const versions = asArray(version.game_versions).filter(
        (value): value is string => typeof value === 'string'
      );
      if (!versions.includes(gameVersion)) return false;
    }
    if (loader) {
      const loaders = asArray(version.loaders).filter(
        (value): value is string => typeof value === 'string'
      );
      if (!loaders.includes(loader)) return false;
    }
    return true;
  });
};

export interface ModpackFile {
  url: string;
  hashes: unknown;
  size: number;
  filename: string;
  dependencies: unknown[];
  projectId: string;
  versionId: string;
}

export const selectPrimaryFile = (files: unknown[]): JsonRecord | null => {
  const records = files
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  if (records.length === 0) return null;
  return records.find((file) => file.primary === true) ?? records[0];
};

export const getModrinthModpack = async (
  projectId: string,
  versionId: string,
  deps: LauncherDeps
): Promise<ModpackFile> => {
  if (!ID_PATTERN.test(projectId) || !ID_PATTERN.test(versionId)) {
    throw new NotFoundError('非法项目或版本 id');
  }

  const version = asRecord(
    await modrinthFetch(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`, deps, true)
  );
  if (!version) throw new UpstreamError('Modrinth 版本响应不是对象');

  // 路由参数叫 projectId，但允许传 slug；用项目响应确认归属。
  const project = asRecord(
    await modrinthFetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`, deps, true)
  );
  const actualProjectId = asString(version.project_id) ?? '';
  if (
    !project ||
    (asString(project.id) !== actualProjectId && asString(project.slug) !== projectId)
  ) {
    throw new NotFoundError('版本不属于该项目');
  }

  const file = selectPrimaryFile(asArray(version.files));
  const url = asString(file?.url);
  const filename = asString(file?.filename);
  const size = asNumber(file?.size);
  if (!file || !url || !filename || size === null) {
    throw new UpstreamError('Modrinth 版本缺少主文件');
  }

  return {
    url,
    hashes: asRecord(file.hashes) ?? {},
    size,
    filename,
    dependencies: asArray(version.dependencies),
    projectId: actualProjectId,
    versionId: asString(version.id) ?? versionId,
  };
};
