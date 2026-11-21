import type { CacheStore } from './cache.ts';
import { NotFoundError, UpstreamError } from './errors.ts';
import type { Mirror } from './manifest.ts';

/**
 * 出站 HTTP 的唯一入口。
 *
 * - 只允许白名单 host，重定向逐跳校验最终 URL；
 * - 统一超时、响应体上限和错误映射（网络/5xx → 502，超时 → 504）；
 * - 文本响应可写入 `upstream_cache`，命中后不再出站。
 *
 * `fetchImpl` 可注入，测试因此完全不联网。
 */
export interface LauncherDeps {
  fetchImpl: typeof fetch;
  cache: CacheStore;
  now: () => number;
  defaultMirror: Mirror;
  modrinthUserAgent: string;
}

export const DEFAULT_USER_AGENT =
  'hydwind-api/0.1.0 (+https://github.com/NmouZh/hydwind-api)';

const OFFICIAL_HOSTS = new Set([
  'launchermeta.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'meta.fabricmc.net',
  'maven.fabricmc.net',
  'meta.quiltmc.org',
  'maven.quiltmc.org',
  'files.minecraftforge.net',
  'maven.minecraftforge.net',
  'maven.neoforged.net',
  'api.modrinth.com',
]);

/**
 * BMCLAPI 的 CDN 节点会 302 到自家镜像域（实测 bmclapi*.hurtmc.com、
 * bmclapi*.sakura.sld.tw、open-bmcl-api.lunar.cc）。只接受这些已知后缀，
 * 且主机名必须以 bmclapi / open-bmcl-api 开头，避免白名单被泛化。
 */
const BMCLAPI_CDN_SUFFIXES = ['.bangbang93.com', '.hurtmc.com', '.sld.tw', '.lunar.cc'];

const isBmclapiCdnHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  if (!BMCLAPI_CDN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return lower.startsWith('bmclapi') || lower.startsWith('open-bmcl-api');
};

export const isAllowedUpstreamHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return OFFICIAL_HOSTS.has(lower) || isBmclapiCdnHost(lower);
};

const MAX_REDIRECTS = 5;

const parseAllowedUrl = (value: string | URL): URL => {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new UpstreamError('上游地址不合法');
  }

  if (url.protocol !== 'https:') {
    throw new UpstreamError('只允许 HTTPS 上游');
  }
  if (!isAllowedUpstreamHost(url.hostname)) {
    throw new UpstreamError(`上游域名不在白名单: ${url.hostname}`);
  }
  return url;
};

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const readLimitedBody = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UpstreamError('上游响应体超过上限');
  }

  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpstreamError('上游响应体超过上限');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
};

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  notFoundStatus?: boolean;
}

export interface SafeFetchResult {
  bytes: Buffer;
  finalUrl: string;
  contentType: string | null;
}

export const safeFetch = async (
  input: string,
  deps: LauncherDeps,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let current = parseAllowedUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await deps.fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: '*/*',
          ...options.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) throw new UpstreamError('上游请求超时', 504);
      throw new UpstreamError('上游请求失败');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new UpstreamError('上游重定向缺少 Location');
      // 丢弃响应体，防止连接未释放。
      await response.body?.cancel();
      current = parseAllowedUrl(new URL(location, current));
      continue;
    }

    if (response.status === 404 && options.notFoundStatus) {
      await response.body?.cancel();
      throw new NotFoundError();
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 408 || response.status === 504) {
        throw new UpstreamError(`上游返回 ${response.status}`, 504);
      }
      throw new UpstreamError(`上游返回 ${response.status}`);
    }

    let bytes: Buffer;
    try {
      bytes = await readLimitedBody(response, maxBytes);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (isTimeoutError(error)) throw new UpstreamError('上游响应超时', 504);
      throw new UpstreamError('读取上游响应失败');
    }

    return {
      bytes,
      finalUrl: current.toString(),
      contentType: response.headers.get('content-type'),
    };
  }

  throw new UpstreamError('上游重定向次数过多');
};

export interface TextFetchOptions {
  ttlMs?: number;
  cacheKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  notFoundStatus?: boolean;
}

export interface TextFetchResult {
  text: string;
  finalUrl: string;
}

/** 取文本；ttlMs > 0 时先读缓存，成功后写回。 */
export const fetchText = async (
  url: string,
  deps: LauncherDeps,
  options: TextFetchOptions = {}
): Promise<TextFetchResult> => {
  const cacheKey = options.cacheKey ?? url;
  const ttlMs = options.ttlMs ?? 0;

  if (ttlMs > 0) {
    const cached = deps.cache.get(cacheKey, deps.now());
    if (cached !== null) return { text: cached, finalUrl: url };
  }

  const result = await safeFetch(url, deps, options);
  const text = result.bytes.toString('utf8');

  if (ttlMs > 0) deps.cache.set(cacheKey, text, ttlMs, deps.now());
  return { text, finalUrl: result.finalUrl };
};

export interface JsonFetchResult<T = unknown> extends TextFetchResult {
  data: T;
}

/** 取 JSON；解析失败按上游故障处理，不把坏缓存留在库里。 */
export const fetchJson = async <T = unknown>(
  url: string,
  deps: LauncherDeps,
  options: TextFetchOptions = {}
): Promise<JsonFetchResult<T>> => {
  const result = await fetchText(url, deps, options);
  try {
    return { ...result, data: JSON.parse(result.text) as T };
  } catch {
    if ((options.ttlMs ?? 0) > 0) deps.cache.delete(options.cacheKey ?? url);
    throw new UpstreamError('上游返回的不是合法 JSON');
  }
};

export const fetchBytes = async (
  url: string,
  deps: LauncherDeps,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> => safeFetch(url, deps, options);
