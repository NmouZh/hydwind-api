import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { loadConfig } from '../config.ts';
import { consumeRateLimit } from '../domain/rate-limit.ts';
import { timingSafeEqualString } from '../domain/timing-safe.ts';
import { json, readJsonObject } from '../http/api-response.ts';
import { handle } from '../http/handler.ts';
import type { ApiContext } from '../http/handler.ts';
import { sqliteCacheStore } from '../launcher/cache.ts';
import type { CacheStore } from '../launcher/cache.ts';
import {
  MAX_OVERRIDES_BYTES,
  matchesEtag,
  packEtag,
  parseClientPackDraft,
  validateOverridesZip,
} from '../launcher/client-pack.ts';
import {
  BadRequestError,
  ManifestError,
  NotFoundError,
  UpstreamError,
} from '../launcher/errors.ts';
import type { LauncherDeps } from '../launcher/http.ts';
import { buildInstallerManifest } from '../launcher/installer.ts';
import { buildLoaderVersions } from '../launcher/loaders.ts';
import type { LoaderType, Platform } from '../launcher/manifest.ts';
import type { Mirror } from '../launcher/mirror.ts';
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
import { createClientPackStore } from '../launcher/pack-store.ts';
import {
  buildNormalizedManifest,
  listMinecraftVersions,
} from '../launcher/service.ts';
import { resolveInheritance } from '../launcher/versions.ts';
import { ZipError } from '../launcher/zip.ts';

/**
 * `/api/launcher/*` 路由。
 *
 * 清单与 Modrinth 等公开接口按客户端 IP 限流；客户端包读取公开并支持
 * ETag，发布走独立令牌的管理接口（不套读接口限流）。上游错误统一 JSON 化。
 * 路由工厂允许注入 fetch/cache/存储目录，测试因此不离开进程。
 */
export interface LauncherRouteOptions {
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  now?: () => number;
  defaultMirror?: Mirror;
  modrinthUserAgent?: string;
  /** 客户端包存储目录；测试注入临时目录，默认取 config.clientPackDir。 */
  clientPackDir?: string;
  /** 客户端包发布令牌；未配置时管理接口返回 401。 */
  launcherAdminToken?: string;
  /** 管理接口请求体上限，默认 64 MiB。 */
  maxClientPackBodyBytes?: number;
}

export const RATE_LIMIT = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const LOADER_TYPES = new Set<LoaderType>(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
const NORMALIZE_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_CLIENT_PACK_BODY_LIMIT = 64 * 1024 * 1024;
const PACK_VERSION_PATTERN = /^[1-9]\d*$/;

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

/** 客户端包管理令牌只认 Bearer，且必须与 ISSUE_ADMIN_TOKEN 分开配置。 */
const isLauncherAdmin = (request: Request, expected: string): boolean => {
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  return bearer.length > 0 && timingSafeEqualString(bearer, expected);
};

/** 鉴权必须先于 bodyLimit：错误令牌一律 401，不因请求体过大变成 413。 */
const launcherAdminGuard = (expected: string): MiddlewareHandler =>
  async (c, next) => {
    if (!isLauncherAdmin(c.req.raw, expected)) {
      return json({ error: 'unauthorized' }, 401);
    }
    await next();
  };

const publishErrorResponse = (error: unknown): Response => {
  if (error instanceof BadRequestError) {
    return json({ error: 'invalid_request', message: error.message }, 400);
  }
  console.error('[hydwind-api] launcher client pack publish error', error);
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

  const launcherAdminToken = options.launcherAdminToken ?? config.launcherAdminToken;
  const maxClientPackBodyBytes =
    options.maxClientPackBodyBytes ?? DEFAULT_CLIENT_PACK_BODY_LIMIT;
  const clientPackStore = createClientPackStore({
    dir: options.clientPackDir ?? config.clientPackDir,
  });

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

  // 客户端包公开读取：原始 pack.json 直接作为响应体，ETag 对原始字节取 SHA-256。
  const clientPack = createRoute(async (request) => {
    const stored = await clientPackStore.readCurrent();
    if (!stored) return json({ error: 'not_found' }, 404);

    const etag = packEtag(stored.raw);
    const headers = {
      etag: `"${etag}"`,
      'cache-control': 'no-cache',
    };
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && matchesEtag(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(stored.raw, {
      status: 200,
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
      },
    });
  });

  const clientPackOverrides = createRoute(async (_request, ctx) => {
    const rawVersion = (ctx.params.packVersion ?? '').trim();
    if (!PACK_VERSION_PATTERN.test(rawVersion)) {
      return json({ error: 'not_found' }, 404);
    }
    const packVersion = Number(rawVersion);
    if (!Number.isSafeInteger(packVersion)) {
      return json({ error: 'not_found' }, 404);
    }

    const zip = await clientPackStore.readOverrides(packVersion);
    if (!zip) return json({ error: 'not_found' }, 404);

    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(zip.length),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  // 管理接口不套读接口限流：发布是低频运维操作，令牌才是边界。
  const publishClientPack = handle(async (request) => {
    try {
      const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.startsWith('multipart/form-data')) {
        throw new BadRequestError('Content-Type 必须是 multipart/form-data');
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new BadRequestError('multipart 请求体不合法');
      }

      const packValue = form.get('pack');
      if (typeof packValue !== 'string') {
        throw new BadRequestError('缺少 pack 字段');
      }

      let packInput: unknown;
      try {
        packInput = JSON.parse(packValue);
      } catch {
        throw new BadRequestError('pack 不是合法 JSON');
      }
      const draft = parseClientPackDraft(packInput);

      let overrides: Buffer | null = null;
      const overridesValue = form.get('overrides');
      if (overridesValue !== null) {
        if (typeof overridesValue === 'string') {
          throw new BadRequestError('overrides 必须是 zip 文件');
        }
        if (overridesValue.size > MAX_OVERRIDES_BYTES) {
          return json({ error: '请求体太大' }, 413);
        }
        overrides = Buffer.from(await overridesValue.arrayBuffer());
      }

      if (overrides === null && draft.overrides !== undefined) {
        throw new BadRequestError('没有 overrides 文件，pack 不能包含 overrides');
      }
      if (overrides !== null && draft.overrides === undefined) {
        throw new BadRequestError('上传了 overrides 文件，pack 必须包含 overrides 清单');
      }
      if (draft.overrides && overrides) {
        validateOverridesZip(overrides, draft.overrides);
      }

      return json(await clientPackStore.publish({ draft, overrides }));
    } catch (error) {
      return publishErrorResponse(error);
    }
  });

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
  app.get('/client', clientPack);
  app.get('/client/overrides/:packVersion', clientPackOverrides);
  app.put(
    '/admin/client-pack',
    launcherAdminGuard(launcherAdminToken),
    bodyLimit({
      maxSize: maxClientPackBodyBytes,
      onError: (c) => c.json({ error: '请求体太大' }, 413),
    }),
    publishClientPack
  );

  return app;
};
