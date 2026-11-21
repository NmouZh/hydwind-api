import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { createRequestCookieJar } from '../src/http/cookie.ts';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionCookie,
  readSession,
  readSessionFromRequest,
} from '../src/http/session.ts';
import { handle, isSecureRequest, resolveClientAddress } from '../src/http/handler.ts';
import { json } from '../src/http/api-response.ts';

const SESSION_SECRET = 'test-session-secret-0123456789';
const ADMIN_SECRET = 'test-admin-secret-0123456789';

/** 改环境变量并在用例结束后恢复，避免用例互相污染。 */
const withEnv = (t: TestContext, values: Record<string, string | undefined>): void => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const jarFromCookie = (cookie: string): ReturnType<typeof createRequestCookieJar> =>
  createRequestCookieJar(
    new Request('http://localhost/', { headers: { cookie } })
  );

const requestWithSession = (token: string): Request =>
  new Request('http://localhost/', {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });

const sign = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

const tokenFor = (
  payload: Record<string, unknown>,
  secret = SESSION_SECRET
): string => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
};

// ---------------------------------------------------------------- cookie

test('cookie 解析：同名后者覆盖，解码容错，非法条目跳过', () => {
  const jar = jarFromCookie(
    'a=1; b=two%20words; a=3; broken=%E0%A4%A; empty=; =ignored; no-equals'
  );

  assert.equal(jar.get('a'), '3');
  assert.equal(jar.get('b'), 'two words');
  assert.equal(jar.get('broken'), '%E0%A4%A');
  assert.equal(jar.get('empty'), '');
  assert.equal(jar.get('missing'), undefined);
});

test('cookie 序列化：默认 Path=/ 与 SameSite=Lax，值做 encodeURIComponent', () => {
  const jar = createRequestCookieJar(new Request('http://localhost/'));
  jar.set('token', 'a b');

  assert.equal(jar.get('token'), 'a b');
  assert.deepEqual(jar.pending(), ['token=a%20b; Path=/; SameSite=Lax']);
});

test('cookie 序列化：自定义属性齐全', () => {
  const jar = createRequestCookieJar(new Request('http://localhost/'));
  jar.set('sid', 'v', {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 60,
    secure: true,
    expires: new Date(Date.UTC(2030, 0, 1)),
  });

  assert.deepEqual(jar.pending(), [
    'sid=v; Path=/api; Max-Age=60; Expires=Tue, 01 Jan 2030 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
  ]);

  const other = createRequestCookieJar(new Request('http://localhost/'));
  other.set('cross', '1', { sameSite: 'none' });
  assert.deepEqual(other.pending(), ['cross=1; Path=/; SameSite=None']);
});

test('cookie 删除：写入过期串并从内存移除', () => {
  const jar = jarFromCookie('sid=abc; keep=1');
  jar.delete('sid');

  assert.equal(jar.get('sid'), undefined);
  assert.equal(jar.get('keep'), '1');
  assert.deepEqual(jar.pending(), [
    'sid=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
  ]);
});

test('cookie 删除可指定 path，set 后 delete 按发生顺序追加', () => {
  const jar = createRequestCookieJar(new Request('http://localhost/'));
  jar.set('sid', 'abc', { path: '/api' });
  jar.delete('sid', { path: '/api' });

  assert.equal(jar.pending().length, 2);
  assert.equal(jar.pending()[0], 'sid=abc; Path=/api; SameSite=Lax');
  assert.equal(
    jar.pending()[1],
    'sid=; Path=/api; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
  );

  const snapshot = jar.pending();
  snapshot.push('injected');
  assert.equal(jar.pending().length, 2);
});

// --------------------------------------------------------------- session

test('session 往返：保留原 cookie 属性与 payload 字段', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const jar = createRequestCookieJar(new Request('http://localhost/'));
  const before = Math.floor(Date.now() / 1000);
  createSessionCookie(jar, 'nz', 'admin', true);

  const serialized = jar.pending()[0];
  assert.ok(serialized);
  assert.match(serialized, /^hydwind_session=/);
  assert.match(serialized, /; Path=\//);
  assert.match(serialized, /; HttpOnly/);
  assert.match(serialized, /; Secure/);
  assert.match(serialized, /; SameSite=Lax/);

  const maxAge = Number(/; Max-Age=(\d+)/.exec(serialized)?.[1]);
  assert.equal(maxAge, 60 * 60 * 24 * 30);

  const token = jar.get(SESSION_COOKIE);
  assert.ok(token);
  const payload = readSessionFromRequest(requestWithSession(token));
  assert.ok(payload);
  assert.equal(payload.username, 'nz');
  assert.equal(payload.role, 'admin');
  assert.ok(payload.exp >= before + maxAge - 2 && payload.exp <= before + maxAge + 2);

  assert.deepEqual(readSession(jarFromCookie(`${SESSION_COOKIE}=${token}`)), payload);
});

test('session secure 默认 false，调用方显式传入才加 Secure', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const jar = createRequestCookieJar(new Request('http://localhost/'));
  createSessionCookie(jar, 'nz', 'player');
  assert.doesNotMatch(jar.pending()[0], /; Secure/);

  const secureJar = createRequestCookieJar(new Request('http://localhost/'));
  createSessionCookie(secureJar, 'nz', 'player', true);
  assert.match(secureJar.pending()[0], /; Secure/);
});

test('session 使用 ISSUE_ADMIN_TOKEN 作为回退签名密钥', (t) => {
  withEnv(t, { SESSION_SECRET: undefined, ISSUE_ADMIN_TOKEN: ADMIN_SECRET });

  const jar = createRequestCookieJar(new Request('http://localhost/'));
  createSessionCookie(jar, 'nz', 'player');

  const token = jar.get(SESSION_COOKIE);
  assert.ok(token);
  const [body, signature] = token.split('.');
  assert.ok(body);
  assert.equal(signature, sign(body, ADMIN_SECRET));

  assert.equal(readSessionFromRequest(requestWithSession(token))?.username, 'nz');
});

test('session 兼容手写格式：base64url(payload).HMAC', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const token = tokenFor({
    username: 'nz',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 600,
  });

  const payload = readSessionFromRequest(requestWithSession(token));
  assert.ok(payload);
  assert.equal(payload.username, 'nz');
  assert.equal(payload.role, 'admin');
});

test('session 篡改 body 或签名都会被拒绝', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const token = tokenFor({
    username: 'nz',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const [body, signature] = token.split('.');
  assert.ok(body);
  assert.ok(signature);

  const tamperedBody = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(readSessionFromRequest(requestWithSession(`${tamperedBody}.${signature}`)), null);

  const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(readSessionFromRequest(requestWithSession(`${body}.${tamperedSignature}`)), null);

  assert.equal(readSessionFromRequest(requestWithSession('garbage')), null);
  assert.equal(readSessionFromRequest(requestWithSession('..')), null);
});

test('session 过期 token 被拒绝，无需等待', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const expired = tokenFor({
    username: 'nz',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  assert.equal(readSessionFromRequest(requestWithSession(expired)), null);

  const malformedCookie = jarFromCookie(`${SESSION_COOKIE}=%E0%A4%A`);
  assert.equal(readSession(malformedCookie), null);
});

test('clearSessionCookie 清空会话并写过期 cookie', (t) => {
  withEnv(t, { SESSION_SECRET, ISSUE_ADMIN_TOKEN: undefined });

  const jar = createRequestCookieJar(new Request('http://localhost/'));
  createSessionCookie(jar, 'nz', 'admin');
  assert.ok(readSession(jar));

  clearSessionCookie(jar);
  assert.equal(readSession(jar), null);
  assert.equal(
    jar.pending()[1],
    'hydwind_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
  );
});

// ------------------------------------------------------- client address

test('resolveClientAddress：受信代理取 XFF 第一个非空值', () => {
  assert.equal(
    resolveClientAddress('127.0.0.1', '  , 203.0.113.7, 10.0.0.1 '),
    '203.0.113.7'
  );
});

test('resolveClientAddress：非受信远端忽略 XFF', () => {
  assert.equal(resolveClientAddress('10.0.0.5', '203.0.113.7'), '10.0.0.5');
});

test('resolveClientAddress：IPv6 回环与 ::ffff 映射', () => {
  assert.equal(resolveClientAddress('::1', '198.51.100.4'), '198.51.100.4');
  assert.equal(resolveClientAddress('::ffff:127.0.0.1', '198.51.100.5'), '198.51.100.5');
  assert.equal(resolveClientAddress('::ffff:7f00:1', '198.51.100.6'), '198.51.100.6');
});

test('resolveClientAddress：IPv4 CIDR 网段匹配，非法 CIDR 忽略', () => {
  const cidrs = ['not-a-cidr', '127.0.0.1/33', '127.0.0.1/-1', '10.0.0.0/8'];

  assert.equal(resolveClientAddress('10.2.3.4', '203.0.113.9', cidrs), '203.0.113.9');
  assert.equal(resolveClientAddress('11.2.3.4', '203.0.113.9', cidrs), '11.2.3.4');
  assert.equal(resolveClientAddress('::ffff:10.1.2.3', '203.0.113.10', cidrs), '203.0.113.10');
});

test('resolveClientAddress：IPv6 CIDR 与 /0 边界', () => {
  assert.equal(
    resolveClientAddress('2001:db8:1::5', '203.0.113.10', ['2001:db8::/32']),
    '203.0.113.10'
  );
  assert.equal(
    resolveClientAddress('2001:db9::5', '203.0.113.10', ['2001:db8::/32']),
    '2001:db9::5'
  );
  assert.equal(resolveClientAddress('8.8.8.8', '203.0.113.11', ['0.0.0.0/0']), '203.0.113.11');
});

test('resolveClientAddress：无 socket 按回环保底并走信任链', () => {
  // 合成请求拿不到对端地址时以回环代替；回环默认受信，所以带 XFF 时采信。
  assert.equal(resolveClientAddress(undefined, '203.0.113.11'), '203.0.113.11');
  assert.equal(resolveClientAddress('  ', '203.0.113.11'), '203.0.113.11');
  assert.equal(resolveClientAddress(undefined, '203.0.113.11', []), '127.0.0.1');
  assert.equal(resolveClientAddress(undefined, null), '127.0.0.1');
  assert.equal(resolveClientAddress('127.0.0.1', null), '127.0.0.1');
  assert.equal(resolveClientAddress('127.0.0.1', '   ', ['127.0.0.1/32']), '127.0.0.1');
  assert.equal(resolveClientAddress('not-an-ip', '203.0.113.11'), 'not-an-ip');
});

// ------------------------------------------------------------- secure

test('isSecureRequest：X-Forwarded-Proto 与 URL 协议', () => {
  assert.equal(isSecureRequest(new Request('https://hydwind.example/')), true);
  assert.equal(isSecureRequest(new Request('http://hydwind.example/')), false);
  assert.equal(
    isSecureRequest(
      new Request('http://hydwind.example/', {
        headers: { 'x-forwarded-proto': 'https' },
      })
    ),
    true
  );
  assert.equal(
    isSecureRequest(
      new Request('http://hydwind.example/', {
        headers: { 'x-forwarded-proto': 'HTTPS, http' },
      })
    ),
    true
  );
  assert.equal(
    isSecureRequest(
      new Request('http://hydwind.example/', {
        headers: { 'x-forwarded-proto': 'http' },
      })
    ),
    false
  );
});

// ------------------------------------------------------------- handle

test('handle 传入 params / origin / clientAddress / cookie，并追加 Set-Cookie', async (t) => {
  withEnv(t, {
    PUBLIC_ORIGIN: 'https://hydwind.example',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  });

  type Seen = {
    id: string;
    origin: string;
    clientAddress: string;
    seed: string | undefined;
  };
  let seen: Seen | null = null;

  const app = new Hono();
  app.get(
    '/users/:id',
    handle(async (_request, ctx) => {
      seen = {
        id: ctx.params.id,
        origin: ctx.origin,
        clientAddress: ctx.clientAddress,
        seed: ctx.cookies.get('seed'),
      };
      ctx.cookies.set('session', 'abc');
      ctx.cookies.set('theme', 'dark', { sameSite: 'strict' });
      return json({ ok: true });
    })
  );

  const response = await app.request('/users/42', { headers: { cookie: 'seed=hello' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.ok(seen);
  assert.deepEqual(seen, {
    id: '42',
    origin: 'https://hydwind.example',
    clientAddress: '127.0.0.1',
    seed: 'hello',
  });

  assert.deepEqual(response.headers.getSetCookie(), [
    'session=abc; Path=/; SameSite=Lax',
    'theme=dark; Path=/; SameSite=Strict',
  ]);
});

test('handle 在受信代理下采信 XFF', async (t) => {
  withEnv(t, { TRUSTED_PROXY_CIDRS: '127.0.0.1/32' });

  let address = '';
  const app = new Hono();
  app.get(
    '/',
    handle(async (_request, ctx) => {
      address = ctx.clientAddress;
      return json({ ok: true });
    })
  );

  const response = await app.request('/', {
    headers: { 'x-forwarded-for': '203.0.113.50, 127.0.0.1' },
  });
  assert.equal(response.status, 200);
  assert.equal(address, '203.0.113.50');
});

test('handle 透传请求体与方法，并保留响应已有的 Set-Cookie', async () => {
  const app = new Hono();
  app.post(
    '/echo/:id',
    handle(async (request, ctx) => {
      ctx.cookies.set('a', '1');
      return new Response(`id=${ctx.params.id}; body=${await request.text()}`, {
        headers: { 'set-cookie': 'existing=yes; Path=/' },
      });
    })
  );

  const response = await app.request('/echo/7', { method: 'POST', body: 'payload' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'id=7; body=payload');
  assert.deepEqual(response.headers.getSetCookie(), [
    'existing=yes; Path=/',
    'a=1; Path=/; SameSite=Lax',
  ]);
});