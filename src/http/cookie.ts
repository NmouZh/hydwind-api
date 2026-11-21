/**
 * 请求级 CookieJar。
 *
 * Astro 的 `AstroCookies` 会直接把 set/delete 挂到响应上；搬到 Hono 后没有这层
 * 上下文，所以这里用一个内存实现：读取来自 request 的 Cookie 头，写入先记在
 * 内存里并序列化成 Set-Cookie 字符串，最后由 `handle()` 追加到响应。
 *
 * 会话 cookie 的格式由 `session.ts` 决定，这里只负责通用的 Cookie 语法。
 */

export type SameSite = 'lax' | 'strict' | 'none';

export interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  sameSite?: SameSite;
  maxAge?: number;
  secure?: boolean;
  expires?: Date;
}

export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string, options?: { path?: string }): void;
  pending(): string[];
}

const DEFAULT_PATH = '/';

const SAME_SITE_LABEL: Record<SameSite, string> = {
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
};

/** Cookie 值解码失败时按原样返回，畸形 cookie 不该把整个请求打成 500。 */
const decodeValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const serialize = (name: string, value: string, options: CookieOptions = {}): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? DEFAULT_PATH}`);

  if (options.maxAge !== undefined && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires && !Number.isNaN(options.expires.getTime())) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${SAME_SITE_LABEL[options.sameSite ?? 'lax']}`);

  return parts.join('; ');
};

/**
 * 从请求头解析 Cookie。同名 cookie 后者覆盖前者（浏览器对重复名的解释也是
 * 以后出现的为准），非法条目直接跳过。
 */
export const createRequestCookieJar = (request: Request): CookieJar => {
  const values = new Map<string, string>();
  const header = request.headers.get('cookie') ?? '';

  for (const part of header.split(';')) {
    const entry = part.trim();
    if (!entry) continue;

    const separator = entry.indexOf('=');
    if (separator <= 0) continue;

    const name = entry.slice(0, separator).trim();
    if (!name) continue;

    values.set(name, decodeValue(entry.slice(separator + 1).trim()));
  }

  const pending: string[] = [];

  return {
    get: (name) => values.get(name),
    set: (name, value, options) => {
      values.set(name, value);
      pending.push(serialize(name, value, options));
    },
    delete: (name, options) => {
      values.delete(name);
      pending.push(
        serialize(name, '', {
          path: options?.path ?? DEFAULT_PATH,
          maxAge: 0,
          expires: new Date(0),
        })
      );
    },
    pending: () => [...pending],
  };
};