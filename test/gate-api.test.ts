import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { registerAccount } from '../src/domain/accounts.ts';
import { LOGIN_CODE_TTL_MS } from '../src/domain/login-codes.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import { SESSION_COOKIE, createSessionCookie } from '../src/http/session.ts';

/**
 * GET /api/gate/codes 的契约，以及它和插件校验接口的串联。
 *
 * Web 的 /gate 页面原来直接调用 generateLoginCodes；拆出后端后页面走这个
 * 接口拿码，HydwindGate 插件再用同一组码调 /api/plugin/login/verify。
 * 两个路由共享默认 SQLite login-code store，所以这里能覆盖完整链路。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const PLUGIN_TOKEN = 'test-plugin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-gate-'));
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

const account = async (username: string): Promise<void> => {
  const result = await registerAccount({
    username,
    platformId: `qq-${username}`,
  });
  assert.equal(result.ok, true, `测试账号创建失败：${username}`);
};

const sessionCookie = (username: string): string => {
  let token = '';
  const jar: CookieJar = {
    get: () => undefined,
    set: (name, value) => {
      if (name === SESSION_COOKIE) token = value;
    },
    delete: () => {},
    pending: () => [],
  };
  createSessionCookie(jar, username, 'player', false);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
};

interface GateCodes {
  code: string;
  fallback: string;
  expiresAt: number;
  ttlMs: number;
}

const getCodes = (
  username: string,
  headers: Record<string, string> = {}
): Promise<Response> =>
  app.request(`${PUBLIC_ORIGIN}/api/gate/codes`, {
    headers: { cookie: sessionCookie(username), ...headers },
  });

const verifyPlugin = (
  body: unknown,
  token: string | null = PLUGIN_TOKEN
): Promise<Response> =>
  app.request(`${PUBLIC_ORIGIN}/api/plugin/login/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

test('GET /api/gate/codes：未登录 / 账号不存在 / 伪造 cookie 都 401', async () => {
  const anonymous = await app.request(`${PUBLIC_ORIGIN}/api/gate/codes`);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: '未登录' });

  const ghost = await app.request(`${PUBLIC_ORIGIN}/api/gate/codes`, {
    headers: { cookie: sessionCookie('GhostGate') },
  });
  assert.equal(ghost.status, 401);
  assert.deepEqual(await ghost.json(), { error: '账号已不存在' });

  const garbage = await app.request(`${PUBLIC_ORIGIN}/api/gate/codes`, {
    headers: { cookie: `${SESSION_COOKIE}=forged-value` },
  });
  assert.equal(garbage.status, 401);
  assert.deepEqual(await garbage.json(), { error: '未登录' });
});

test('GET /api/gate/codes：登录后返回 code / fallback / expiresAt / ttlMs', async () => {
  await account('GateUser');

  const before = Date.now();
  const response = await getCodes('GateUser');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = (await response.json()) as GateCodes;
  assert.equal(typeof body.code, 'string');
  assert.ok(body.code.length > 0);
  assert.match(body.fallback, /^HWG-[A-Z0-9]{4}$/);
  assert.equal(body.ttlMs, LOGIN_CODE_TTL_MS);
  assert.ok(body.expiresAt >= before + LOGIN_CODE_TTL_MS - 1000);
  assert.ok(body.expiresAt <= Date.now() + LOGIN_CODE_TTL_MS + 1000);
});

test('GET /api/gate/codes：带 Origin 时必须同源', async () => {
  await account('GateOrigin');

  const crossed = await getCodes('GateOrigin', { origin: 'https://evil.example' });
  assert.equal(crossed.status, 403);
  assert.deepEqual(await crossed.json(), { error: '请求来源不对' });

  const sameOrigin = await getCodes('GateOrigin', { origin: PUBLIC_ORIGIN });
  assert.equal(sameOrigin.status, 200);
});

test('gate 生成的码可被插件消费；同码再用 409，缺令牌 401', async () => {
  await account('GateChain');

  const response = await getCodes('GateChain');
  assert.equal(response.status, 200);
  const codes = (await response.json()) as GateCodes;

  const verified = await verifyPlugin({
    code: codes.code,
    gameId: 'GateChain',
    uuid: UUID,
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    ok: true,
    account: { username: 'GateChain', nickname: 'GateChain', role: 'player' },
  });

  const reused = await verifyPlugin({
    code: codes.code,
    gameId: 'GateChain',
    uuid: UUID,
  });
  assert.equal(reused.status, 409);
  assert.deepEqual(await reused.json(), { ok: false, reason: 'used' });

  // 备用码与颜文字码同一条记录，也已作废。
  const fallbackReused = await verifyPlugin({
    code: codes.fallback,
    gameId: 'GateChain',
    uuid: UUID,
  });
  assert.equal(fallbackReused.status, 409);

  const anonymous = await verifyPlugin(
    { code: 'irrelevant', gameId: 'GateChain', uuid: UUID },
    null
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { ok: false, reason: 'unauthorized' });

  const wrongToken = await verifyPlugin(
    { code: 'irrelevant', gameId: 'GateChain', uuid: UUID },
    'wrong-token'
  );
  assert.equal(wrongToken.status, 401);

  const adminToken = await verifyPlugin(
    { code: 'irrelevant', gameId: 'GateChain', uuid: UUID },
    ADMIN_TOKEN
  );
  assert.equal(adminToken.status, 401);
});

test('GET /api/gate/codes：每账号每 IP 5 分钟最多 12 次', async () => {
  await account('GateLimit');

  for (let index = 0; index < 12; index += 1) {
    const response = await getCodes('GateLimit');
    assert.equal(response.status, 200, `第 ${index + 1} 次生成应成功`);
  }

  const limited = await getCodes('GateLimit');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const body = (await limited.json()) as { error?: unknown };
  assert.equal(typeof body.error, 'string');
});

test('GET /api/gate/codes：候选池异常时返回 503，不泄露内部错误', async (t) => {
  await account('GateBroken');
  withEnv(t, { LOGIN_CODE_KAOMOJI_POOL: 'only-one' });

  const response = await getCodes('GateBroken');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: '登录码暂时生成不出来，请稍后重试',
  });
});