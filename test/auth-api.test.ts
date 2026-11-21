import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { findBiographyByGameId } from '../src/domain/biographies.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import {
  SESSION_COOKIE,
  createSessionCookie,
} from '../src/http/session.ts';

/**
 * /api/auth/* 的路由级契约。
 *
 * 用 createApp().request 直接打路由，不监听端口；临时数据目录在模块加载时
 * 设置，确保第一次 getDb 之前环境变量已经就位。同一进程内的限流桶是模块级
 * 状态，所以每个用例使用不同的账号，并控制会走到限流器的登录次数。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const PLUGIN_TOKEN = 'test-plugin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-auth-'));
process.env.HYDWIND_DATA_DIR = dataDir;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.ISSUE_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.PLUGIN_TOKEN = PLUGIN_TOKEN;
process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
delete process.env.HYDWIND_DB_PATH;

after(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const app = createApp();

const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
  app.request(`${PUBLIC_ORIGIN}${path}`, init);

const postJson = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const asAdmin = (): Record<string, string> => ({
  authorization: `Bearer ${ADMIN_TOKEN}`,
});

const sessionCookie = (
  username: string,
  role: 'admin' | 'player' = 'player'
): string => {
  let token = '';
  const jar: CookieJar = {
    get: () => undefined,
    set: (name, value) => {
      if (name === SESSION_COOKIE) token = value;
    },
    delete: () => {},
    pending: () => [],
  };
  createSessionCookie(jar, username, role, false);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
};

const cookieFrom = (response: Response): string => {
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(header, '响应应下发会话 cookie');
  return header.split(';')[0];
};

test('register：无令牌、错误令牌都 401，正确令牌才放行', async () => {
  const body = {
    username: 'AuthGate',
    platformId: 'qq-auth-gate',
    password: 'secret123',
  };

  const anonymous = await postJson('/api/auth/register', body);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: '需要站务令牌' });

  const wrong = await postJson('/api/auth/register', body, {
    authorization: 'Bearer wrong-token',
  });
  assert.equal(wrong.status, 401);
});

test('register：成功返回原字段，并按新约定创建默认传记', async () => {
  const response = await postJson(
    '/api/auth/register',
    {
      username: 'AuthAlice',
      platformId: 'qq-auth-alice',
      nickname: '爱丽丝',
      password: 'secret123',
      role: 'admin',
    },
    asAdmin()
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    username: 'AuthAlice',
    password: 'secret123',
    role: 'admin',
    created: true,
  });

  const biography = await findBiographyByGameId('authalice');
  assert.ok(biography, '注册后应存在默认传记');
  assert.equal(biography.gameId, 'AuthAlice');
  assert.equal(biography.mainTitle, 'AuthAlice的人物传记');
  assert.equal(biography.body, '');
});

test('register：参数校验与请求体上限沿用原错误形状', async () => {
  const tooShort = await postJson(
    '/api/auth/register',
    { username: 'ab', platformId: 'qq-short' },
    asAdmin()
  );
  assert.equal(tooShort.status, 400);
  assert.equal(typeof ((await tooShort.json()) as { error?: unknown }).error, 'string');

  const malformed = await postJson('/api/auth/register', '{', asAdmin());
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: '请求体不是合法 JSON' });

  const oversized = await postJson(
    '/api/auth/register',
    'x'.repeat(5000),
    asAdmin()
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: '请求体太大' });
});

test('register：同一平台身份重复注册是密码重置，created=false', async () => {
  const reset = await postJson(
    '/api/auth/register',
    {
      username: 'AuthReset',
      platformId: 'qq-auth-reset',
      password: 'first-pass',
    },
    asAdmin()
  );
  assert.equal(reset.status, 200);
  assert.equal(((await reset.json()) as { created?: unknown }).created, true);

  const again = await postJson(
    '/api/auth/register',
    {
      username: 'AuthReset',
      platformId: 'qq-auth-reset',
      nickname: '重置过',
      password: 'second-pass',
    },
    asAdmin()
  );
  assert.equal(again.status, 200);
  const body = (await again.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    username: 'AuthReset',
    password: 'second-pass',
    role: 'player',
    created: false,
  });

  const oldPassword = await postJson('/api/auth/login', {
    username: 'AuthReset',
    password: 'first-pass',
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await postJson('/api/auth/login', {
    username: 'AuthReset',
    password: 'second-pass',
  });
  assert.equal(newPassword.status, 200);
});

test('login/me/logout：成功下发会话 cookie，me 回查账号，logout 清 cookie', async () => {
  const registered = await postJson(
    '/api/auth/register',
    {
      username: 'AuthBob',
      platformId: 'qq-auth-bob',
      nickname: '小波',
      password: 'bob-pass-1',
    },
    asAdmin()
  );
  assert.equal(registered.status, 200);

  const response = await postJson('/api/auth/login', {
    username: 'AuthBob',
    password: 'bob-pass-1',
  });
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    account?: Record<string, unknown>;
  };
  assert.ok(body.account);
  assert.equal(body.account.username, 'AuthBob');
  assert.equal(body.account.nickname, '小波');
  assert.equal(body.account.role, 'player');
  assert.equal(typeof body.account.createdAt, 'string');
  assert.equal(typeof body.account.lastLoginAt, 'string');

  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^hydwind_session=/);
  assert.match(cookies[0], /; Path=\//);
  assert.match(cookies[0], /; HttpOnly/);
  assert.match(cookies[0], /; SameSite=Lax/);
  assert.match(cookies[0], /; Max-Age=2592000/);
  assert.doesNotMatch(cookies[0], /; Secure/);

  const cookie = cookieFrom(response);
  const me = await request('/api/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { account?: Record<string, unknown> };
  assert.equal(meBody.account?.username, 'AuthBob');
  assert.equal(meBody.account?.nickname, '小波');

  const anonymous = await request('/api/auth/me');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: '未登录' });

  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  const cleared = logout.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cleared);
  assert.match(cleared, /Max-Age=0/);
});

test('login：X-Forwarded-Proto=https 时会话 cookie 带 Secure', async () => {
  const response = await postJson(
    '/api/auth/login',
    { username: 'AuthBob', password: 'bob-pass-1' },
    { 'x-forwarded-proto': 'https' }
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie()[0], /; Secure/);
});

test('me：cookie 里的 role 不可信，账号不存在时 401', async () => {
  const forgedRole = await request('/api/auth/me', {
    headers: { cookie: sessionCookie('AuthBob', 'admin') },
  });
  assert.equal(forgedRole.status, 200);
  const body = (await forgedRole.json()) as {
    account?: { role?: unknown };
  };
  assert.equal(body.account?.role, 'player');

  const ghost = await request('/api/auth/me', {
    headers: { cookie: sessionCookie('GhostAuth', 'admin') },
  });
  assert.equal(ghost.status, 401);
  assert.deepEqual(await ghost.json(), { error: '账号已不存在' });

  const garbage = await request('/api/auth/me', {
    headers: { cookie: `${SESSION_COOKIE}=forged-value` },
  });
  assert.equal(garbage.status, 401);
  assert.deepEqual(await garbage.json(), { error: '未登录' });
});

test('login：同源、JSON、字段与失败文案都按原契约拒绝', async () => {
  const crossed = await postJson(
    '/api/auth/login',
    { username: 'AuthBob', password: 'bob-pass-1' },
    { origin: 'https://evil.example' }
  );
  assert.equal(crossed.status, 403);
  assert.deepEqual(await crossed.json(), { error: '请求来源不对' });

  const wrongType = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ username: 'AuthBob', password: 'bob-pass-1' }),
  });
  assert.equal(wrongType.status, 415);

  const malformed = await postJson('/api/auth/login', '{');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: '请求体不是合法 JSON' });

  const notObject = await postJson('/api/auth/login', '"hello"');
  assert.equal(notObject.status, 400);
  assert.deepEqual(await notObject.json(), { error: '请求体格式不对' });

  const wrongPassword = await postJson('/api/auth/login', {
    username: 'AuthBob',
    password: 'not-the-password',
  });
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await wrongPassword.json(), { error: '账号或密码不对' });

  const unknown = await postJson('/api/auth/login', {
    username: 'NoSuchAuthUser',
    password: 'whatever',
  });
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: '账号或密码不对' });

  const missing = await postJson('/api/auth/login', { username: 'AuthBob' });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: '账号和密码都要填' });

  const tooLong = await postJson('/api/auth/login', {
    username: 'x'.repeat(65),
    password: 'whatever',
  });
  assert.equal(tooLong.status, 400);
  assert.deepEqual(await tooLong.json(), { error: '账号或密码太长' });
});