import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { loadConfig } from '../config.ts';
import { createRequestCookieJar } from './cookie.ts';
import type { CookieJar } from './cookie.ts';

/**
 * Astro handler → Hono handler 的适配层。
 *
 * 原站点的 API 路由主体保留成 `(request, ctx) => Promise<Response>`；这里补上
 * 它们依赖的上下文（路径参数、客户端 IP、CookieJar、对外 origin）并把
 * CookieJar 里积累的 Set-Cookie 追加到响应上。
 */

export interface ApiContext {
  params: Record<string, string>;
  clientAddress: string;
  cookies: CookieJar;
  origin: string;
}

export type ApiHandler = (request: Request, ctx: ApiContext) => Promise<Response>;

export const DEFAULT_TRUSTED_PROXY_CIDRS: string[] = ['127.0.0.1/32', '::1/128'];

const FALLBACK_CLIENT_ADDRESS = '127.0.0.1';

interface ParsedAddress {
  bytes: number[];
  family: 4 | 6;
}

interface ParsedCidr extends ParsedAddress {
  prefix: number;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_PATTERN = /^[0-9a-fA-F]{1,4}$/;

/** 去掉 `[...]` 包裹与 IPv6 zone id（`fe80::1%eth0`）。 */
const stripAddressDecoration = (value: string): string => {
  let result = value.trim();
  if (result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1);
  const zone = result.indexOf('%');
  if (zone >= 0) result = result.slice(0, zone);
  return result;
};

const parseIPv4 = (value: string): number[] | null => {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return null;

  const bytes: number[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const part = Number(match[index]);
    if (part > 255) return null;
    bytes.push(part);
  }
  return bytes;
};

const parseIpv6Groups = (value: string): number[] | null => {
  if (!value) return [];

  const pieces = value.split(':');
  const groups: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];

    if (piece.includes('.')) {
      // 内嵌 IPv4 只能出现在最后一组
      if (index !== pieces.length - 1) return null;
      const embedded = parseIPv4(piece);
      if (!embedded) return null;
      groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
      continue;
    }

    if (!HEX_GROUP_PATTERN.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
};

/** 解析 IPv6 文本（含 `::` 压缩与内嵌 IPv4），返回 16 字节。 */
const parseIPv6 = (value: string): number[] | null => {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return null;

  const firstDouble = value.indexOf('::');
  if (firstDouble >= 0 && value.indexOf('::', firstDouble + 2) >= 0) return null;

  const headText = firstDouble >= 0 ? value.slice(0, firstDouble) : value;
  const tailText = firstDouble >= 0 ? value.slice(firstDouble + 2) : null;

  const head = parseIpv6Groups(headText);
  if (!head) return null;

  let groups: number[];
  if (tailText === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = parseIpv6Groups(tailText);
    if (!tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }

  return groups.flatMap((group) => [group >> 8, group & 0xff]);
};

/**
 * 把地址文本解析成字节。`::ffff:127.0.0.1`（以及 `::ffff:7f00:1`）会归一成
 * IPv4，这样默认的 `127.0.0.1/32` 也能匹配到 Node 常见的映射地址。
 */
const parseAddress = (raw: string): ParsedAddress | null => {
  const value = stripAddressDecoration(raw);
  if (!value) return null;

  const ipv4 = parseIPv4(value);
  if (ipv4) return { bytes: ipv4, family: 4 };

  const ipv6 = parseIPv6(value);
  if (!ipv6) return null;

  const mapped =
    ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
  if (mapped) return { bytes: ipv6.slice(12), family: 4 };

  return { bytes: ipv6, family: 6 };
};

const parseCidr = (raw: string): ParsedCidr | null => {
  const value = raw.trim();
  const slash = value.lastIndexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;

  const address = parseAddress(value.slice(0, slash));
  if (!address) return null;

  const prefixText = value.slice(slash + 1).trim();
  if (!/^\d{1,3}$/.test(prefixText)) return null;

  const prefix = Number(prefixText);
  const maxPrefix = address.family === 4 ? 32 : 128;
  if (prefix > maxPrefix) return null;

  return { ...address, prefix };
};

const matchesCidr = (address: ParsedAddress, cidr: ParsedCidr): boolean => {
  if (address.family !== cidr.family) return false;

  const fullBytes = Math.floor(cidr.prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address.bytes[index] !== cidr.bytes[index]) return false;
  }

  const remainder = cidr.prefix % 8;
  if (remainder === 0) return true;

  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address.bytes[fullBytes] & mask) === (cidr.bytes[fullBytes] & mask);
};

/**
 * 解析客户端地址。
 *
 * 只在直连对端命中 TRUSTED_PROXY_CIDRS 时才采信 X-Forwarded-For 的第一个
 * 非空值；否则 XFF 由外网客户端随意伪造，一律忽略。非法 CIDR 忽略。
 */
export const resolveClientAddress = (
  remoteAddress: string | undefined,
  forwardedFor: string | null,
  trustedCidrs: string[] = DEFAULT_TRUSTED_PROXY_CIDRS
): string => {
  const remote = remoteAddress?.trim() ?? '';
  if (!remote) return FALLBACK_CLIENT_ADDRESS;

  const address = parseAddress(remote);
  if (!address) return remote;

  const trusted = trustedCidrs
    .map(parseCidr)
    .some((cidr) => cidr !== null && matchesCidr(address, cidr));
  if (!trusted) return remote;

  const firstForwarded = (forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return firstForwarded ?? remote;
};

/** 当前请求的客户端地址；合成上下文（如 `app.request()`）拿不到 socket 时保底回环。 */
export const clientAddress = (c: Context): string => {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    remote = undefined;
  }

  return resolveClientAddress(
    remote,
    c.req.header('x-forwarded-for') ?? null,
    loadConfig().trustedProxyCidrs
  );
};

/** 真实请求协议：反代后面以 X-Forwarded-Proto 为准，否则看 URL。 */
export const isSecureRequest = (request: Request): boolean => {
  const forwarded = (request.headers.get('x-forwarded-proto') ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwarded === 'https') return true;

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
};

export const handle = (fn: ApiHandler) =>
  async (c: Context): Promise<Response> => {
    const request = c.req.raw;
    const ctx: ApiContext = {
      // 无参 param() 在未注册路径泛型的 Context 上返回较窄的类型，运行时就是全部路径参数
      params: c.req.param() as Record<string, string>,
      clientAddress: clientAddress(c),
      cookies: createRequestCookieJar(request),
      origin: loadConfig().publicOrigin,
    };

    const response = await fn(request, ctx);

    for (const cookie of ctx.cookies.pending()) {
      response.headers.append('set-cookie', cookie);
    }

    return response;
  };