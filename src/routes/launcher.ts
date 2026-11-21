import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadConfig } from '../config.ts';
import { consumeRateLimit } from '../domain/rate-limit.ts';
import { json, readJsonObject } from '../http/api-response.ts';
import { handle } from '../http/handler.ts';
import type { ApiContext } from '../http/handler.ts';
import { sqliteCacheStore } from '../launcher/cache.ts';
import type { CacheStore } from '../launcher/cache.ts';
import {
  BadRequestError,
  ManifestError,
  NotFoundError,
  UpstreamError,
} from '../launcher/errors.ts';
import type { LauncherDeps } from '../launcher/http.ts';
import { buildInstallerManifest } from '../launcher/installer.ts';
import { buildLoaderVersions } from '../launcher/loaders.ts';
import type { LoaderType, Mirror, Platform } from '../launcher/manifest.ts';
import {
  isValidVersionId,
  normalizeArch,
  normalizeOs,
  normalizeVersionJson,
} from '../launcher/manifest.ts';
import {
  getModrinthModpack,
  getModrinthProject,
  listModrinthVersions,
  searchModrinth,
} from '../launcher/modrinth.ts';
import {
  buildNormalizedManifest,
  listMinecraftVersions,
} from '../launcher/service.ts';
import { resolveInheritance } from '../launcher/versions.ts';
import { ZipError } from '../launcher/zip.ts';

/**
 * `/api/launcher/*` 路由。
 *
 * 全部是公开 GET（normalize 为 POST），按客户端 IP 限流；上游错误统一
 * JSON 化。路由工厂允许注入 fetch/cache，测试因此不离开进程。
 */
export interface LauncherRouteOptions {
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  now?: () => number;
  defaultMirror?: Mirror;
  modrinthUserAgent?: string;
}

export const RATE_LIMIT = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const LOADER_TYPES = new Set<LoaderType>(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
const NORMALIZE_BODY_LIMIT = 2 * 1024 * 1024;

type LauncherHandler = (request: Request, ctx: ApiContext) => Promise<Response>;

const errorResponse = (error: unknown): Response => {
  if (error instanceof BadRequestError) {
    return json({ error: 'invalid_request', message: error.message }, 400);
  }
  if (error instanceof ManifestError) {
    return json({ error: 'invalid_manifest', message: error.message }, 400);
  }
  if (error instanceof NotFoundError) return json({ error: 'not_found' }, 404);
  if (error instanceof ZipError) return json({ error: 'upstream_unavailable' }, 502);
  if (error instanceof UpstreamError) {
    return error.status === 504
      ? json({ error: 'upstream_timeout' }, 504)
      : json({ error: 'upstream_unavailable' }, 502);
  }

  console.error('[hydwind-api] launcher error', error);
  return json({ error: 'internal_error' }, 500);
};

const createRoute = (fn: LauncherHandler) =>
  handle(async (request, ctx) => {
    const limit = consumeRateLimit(
      `launcher:${ctx.clientAddress}`,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );
    if (!limit.ok) {
      return json({ error: 'rate_limited' }, 429, {
        'retry-after': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
      });
    }

    try {
      return await fn(request, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  });

const params = (request: Request): URLSearchParams => new URL(request.url).searchParams;

const requireString = (value: string | null, name: string): string => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new BadRequestError(`缺少 ${name}`);
  return trimmed;
};

const parsePlatform = (request: Request): Platform => {
  const query = params(request);
  const os = normalizeOs(query.get('os')?.trim() || 'linux');
  if (!os) throw new BadRequestError('os 必须是 windows / osx / linux');

  const arch = normalizeArch(query.get('arch')?.trim() || 'x86_64');
  if (!arch) throw new BadRequestError('arch 必须是 x86 / x86_64 / arm64');

  return { os, arch };
};

const parseMirror = (request: Request, fallback: Mirror): Mirror => {
  const value = params(request).get('mirror')?.trim().toLowerCase() ?? '';
  if (!value) return fallback;
  if (value === 'official' || value === 'bmclapi') return value;
  throw new BadRequestError('mirror 必须是 official / bmclapi');
};

const parseLoader = (value: string | null): LoaderType => {
  const loader = (value?.trim() || 'vanilla') as LoaderType;
  if (!LOADER_TYPES.has(loader)) {
    throw new BadRequestError('loader 必须是 vanilla / fabric / quilt / forge / neoforge');
  }
  return loader;
};

export const createLauncherRoutes = (options: LauncherRouteOptions = {}): Hono => {
  const config = loadConfig();
  const deps: LauncherDeps = {
    fetchImpl: options.fetchImpl ?? fetch,
    cache: options.cache ?? sqliteCacheStore(),
    now: options.now ?? Date.now,
    defaultMirror: options.defaultMirror ?? config.mirror,
    modrinthUserAgent: options.modrinthUserAgent ?? config.modrinthUserAgent,
  };

  const versions = createRoute(async () => json(await listMinecraftVersions(deps)));

  const loaders = createRoute(async (request) => {
    const gameVersion = requireString(params(request).get('gameVersion'), 'gameVersion');
    return json(await buildLoaderVersions(gameVersion, deps));
  });

  const manifest = createRoute(async (request) => {
    const query = params(request);
    const version = requireString(query.get('version'), 'version');
    if (!isValidVersionId(version)) throw new BadRequestError('非法 version');
    const loader = parseLoader(query.get('loader'));
    const platform = parsePlatform(request);
    const mirror = parseMirror(request, deps.defaultMirror);

    if (loader === 'forge' || loader === 'neoforge') {
      const loaderVersion = requireString(query.get('loaderVersion'), 'loaderVersion');
      return json(
        await buildInstallerManifest(
          { gameVersion: version, loader, loaderVersion, platform, mirror },
          deps
        )
      );
    }

    const loaderVersion = query.get('loaderVersion')?.trim() || undefined;
    return json(
      await buildNormalizedManifest(
        { version, loader, loaderVersion, platform, mirror },
        deps
      )
    );
  });

  const normalize = createRoute(async (request) => {
    const platform = parsePlatform(request);
    const mirror = parseMirror(request, deps.defaultMirror);

    const body = await readJsonObject(request, NORMALIZE_BODY_LIMIT);
    if (!body.ok) return body.response;

    const inherited = await resolveInheritance(body.value, deps, mirror);
    const id = body.value.id;
    if (typeof id !== 'string' || !isValidVersionId(id)) {
      throw new BadRequestError('版本 JSON 的 id 不合法');
    }

    const normalized = normalizeVersionJson(inherited.merged, {
      platform,
      mirror,
      id,
      gameVersion: inherited.rootId,
      loader: null,
    });
    return json(normalized);
  });

  const modrinthSearch = createRoute(async (request) => {
    const query = params(request);
    return json(
      await searchModrinth(
        {
          query: query.get('query'),
          projectType: query.get('projectType'),
          gameVersion: query.get('gameVersion'),
          loader: query.get('loader'),
          limit: query.get('limit'),
          offset: query.get('offset'),
        },
        deps
      )
    );
  });

  const modrinthProject = createRoute(async (_request, ctx) =>
    json(await getModrinthProject(ctx.params.idOrSlug ?? '', deps))
  );

  const modrinthVersions = createRoute(async (request, ctx) => {
    const query = params(request);
    return json(
      await listModrinthVersions(
        ctx.params.idOrSlug ?? '',
        { gameVersion: query.get('gameVersion'), loader: query.get('loader') },
        deps
      )
    );
  });

  const modrinthModpack = createRoute(async (_request, ctx) =>
    json(
      await getModrinthModpack(
        ctx.params.projectId ?? '',
        ctx.params.versionId ?? '',
        deps
      )
    )
  );

  const app = new Hono();
  app.get('/versions', versions);
  app.get('/loaders', loaders);
  app.get('/manifest', manifest);
  app.post(
    '/manifest/normalize',
    bodyLimit({
      maxSize: NORMALIZE_BODY_LIMIT,
      onError: (c) => c.json({ error: '请求体太大' }, 413),
    }),
    normalize
  );
  app.get('/modrinth/search', modrinthSearch);
  app.get('/modrinth/project/:idOrSlug/versions', modrinthVersions);
  app.get('/modrinth/project/:idOrSlug', modrinthProject);
  app.get('/modrinth/modpack/:projectId/:versionId', modrinthModpack);

  return app;
};
