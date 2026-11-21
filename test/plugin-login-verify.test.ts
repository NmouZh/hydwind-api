import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb, getDb } from '../src/db/database.ts';
import { registerAccount } from '../src/domain/accounts.ts';
import { findBiographyByGameId, listGameBiographies, updateBiography } from '../src/domain/biographies.ts';
import { generateLoginCodes } from '../src/domain/login-codes.ts';

/**
 * POST /api/plugin/login/verify 的契约测试（原 hydwind-web 用例的路由级移植）。
 *
 * 路由、鉴权、参数校验、登录码校验和账号回查全部走 createApp().request；
 * 登录码模块的 defaultStore 在测试进程内共享，所以领域层生成码、路由层校验码
 * 与线上「/gate 生成 → 插件校验」的链路一致。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const PLUGIN_TOKEN = 'plugin-secret-value';
const ADMIN_TOKEN = 'admin-secret-value';
const SESSION_SECRET = 'test-session-secret-0123456789';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-plugin-'));
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

interface CallOptions {
  /** 传 null 表示完全不带 Authorization 头 */
  token?: string | null;
  cookie?: string;
  body?: unknown;
  raw?: string;
  /** 传 null 表示不带 content-type */
  contentType?: string | null;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

const call = async (options: CallOptions = {}): Promise<CallResult> => {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? PLUGIN_TOKEN}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  const body =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

  const response = await app.request(
    `${PUBLIC_ORIGIN}/api/plugin/login/verify`,
    { method: 'POST', headers, body }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const createAccount = async (
  username: string,
  options: { nickname?: string; role?: 'admin' | 'player' } = {}
): Promise<void> => {
  const result = await registerAccount({
    username,
    platformId: `qq-${username}`,
    nickname: options.nickname,
    role: options.role,
  });
  assert.equal(result.ok, true, `测试账号创建失败：${username}`);
};

test('200：有效插件令牌 + 未使用的码返回账号用户名、昵称与角色', async () => {
  await createAccount('PvAlice', { nickname: '爱丽丝', role: 'admin' });
  const { code } = generateLoginCodes({ username: 'PvAlice' });

  // gameId 大小写不敏感；响应里的 username 用账号存储里的原始大小写
  const result = await call({ body: { code, gameId: 'pvalice', uuid: UUID } });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    account: { username: 'PvAlice', nickname: '爱丽丝', role: 'admin' },
  });

  const biography = await findBiographyByGameId('pvalice');
  assert.ok(biography, '首次成功验证应为账号创建传记');
  assert.equal(biography.gameId, 'PvAlice');
  assert.equal(biography.mainTitle, 'PvAlice的人物传记');
  assert.equal(biography.body, '');
  assert.deepEqual(biography.comments, []);
});

test('200：昵称为空时返回账号名，不缺字段', async () => {
  await createAccount('PvBob');
  const { fallback } = generateLoginCodes({ username: 'PvBob' });

  const result = await call({ body: { code: fallback, gameId: 'PvBob', uuid: UUID } });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    account: { username: 'PvBob', nickname: 'PvBob', role: 'player' },
  });
});

test('200：同一账号使用新码再次验证时不重复创建或覆盖传记', async () => {
  await createAccount('PvReturning');
  const firstCode = generateLoginCodes({ username: 'PvReturning' }).code;
  const first = await call({
    body: { code: firstCode, gameId: 'PvReturning', uuid: UUID },
  });
  assert.equal(first.status, 200);

  const edited = await updateBiography('PvReturning', {
    mainTitle: '回访玩家的传记',
    body: '已经写好的内容',
  });
  assert.equal(edited.ok, true);

  const nextCode = generateLoginCodes({ username: 'PvReturning' }).code;
  const second = await call({
    body: { code: nextCode, gameId: 'pvreturning', uuid: UUID },
  });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);

  const biographies = await listGameBiographies();
  const mine = biographies.filter(
    (biography) => biography.gameId.toLowerCase() === 'pvreturning'
  );
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mainTitle, '回访玩家的传记');
  assert.equal(mine[0].body, '已经写好的内容');
});

test('200：传记写入失败只记录错误，不阻断插件登录验证', async () => {
  await createAccount('PvStorage');
  const { code } = generateLoginCodes({ username: 'PvStorage' });

  const db = getDb();
  db.exec(
    `CREATE TRIGGER pv_fail_bio_insert BEFORE INSERT ON biographies
     BEGIN SELECT RAISE(ABORT, 'boom'); END`
  );

  const errors: unknown[][] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await call({ body: { code, gameId: 'PvStorage', uuid: UUID } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      account: { username: 'PvStorage', nickname: 'PvStorage', role: 'player' },
    });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /biography creation failed/);
  } finally {
    console.error = previousError;
    db.exec('DROP TRIGGER pv_fail_bio_insert');
  }
});

test('401：不带令牌、错误令牌、站务令牌都拒绝', async () => {
  for (const token of [null, 'wrong-token', ADMIN_TOKEN]) {
    const result = await call({
      token,
      body: { code: 'irrelevant', gameId: 'PvAlice', uuid: UUID },
    });
    assert.equal(result.status, 401, `令牌 ${String(token)} 应被拒绝`);
    assert.deepEqual(result.body, { ok: false, reason: 'unauthorized' });
  }
});

test('401：只带浏览器会话 cookie 不能调用插件接口', async () => {
  const result = await call({
    token: null,
    cookie: 'hydwind_session=forged-session-value',
    body: { code: 'irrelevant', gameId: 'PvAlice', uuid: UUID },
  });

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { ok: false, reason: 'unauthorized' });
});

test('401：未配置 PLUGIN_TOKEN 时一律拒绝', async (t) => {
  withEnv(t, { PLUGIN_TOKEN: undefined });

  const result = await call({ token: ADMIN_TOKEN, body: { code: 'x', gameId: 'x', uuid: UUID } });

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { ok: false, reason: 'unauthorized' });
});

test('409：未知码返回 invalid_code', async () => {
  await createAccount('PvInvalid');
  const result = await call({
    body: { code: 'definitely-not-a-login-code', gameId: 'PvInvalid', uuid: UUID },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { ok: false, reason: 'invalid_code' });
});

test('409：过期码返回 expired', async () => {
  await createAccount('PvExpired');
  // 把生成时间推到 10 分钟前，校验时按真实时间一定过期
  const { code } = generateLoginCodes(
    { username: 'PvExpired' },
    { now: () => Date.now() - 10 * 60_000 }
  );

  const result = await call({ body: { code, gameId: 'PvExpired', uuid: UUID } });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { ok: false, reason: 'expired' });
});

test('409：同一码第二次使用返回 used', async () => {
  await createAccount('PvUsed');
  const { code, fallback } = generateLoginCodes({ username: 'PvUsed' });

  const first = await call({ body: { code, gameId: 'PvUsed', uuid: UUID } });
  assert.equal(first.status, 200);

  // 颜文字码和 ASCII 备用码绑定同一记录，任一用过后另一个也作废
  const second = await call({ body: { code: fallback, gameId: 'PvUsed', uuid: UUID } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { ok: false, reason: 'used' });
});

test('409：游戏 ID 与码绑定的 ID 不符返回 game_id_mismatch', async () => {
  await createAccount('PvMismatch');
  const { code } = generateLoginCodes({ username: 'PvMismatch' });

  const result = await call({ body: { code, gameId: 'SomeoneElse', uuid: UUID } });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    ok: false,
    reason: 'game_id_mismatch',
    expectedGameId: 'PvMismatch',
  });
});

test('409：码本身有效但 gameId 与账号 username 不一致，也返回 game_id_mismatch', async () => {
  await createAccount('PvAccount');
  const { code } = generateLoginCodes({ username: 'PvAccount', gameId: 'OtherGame' });

  const result = await call({ body: { code, gameId: 'othergame', uuid: UUID } });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    ok: false,
    reason: 'game_id_mismatch',
    expectedGameId: 'PvAccount',
  });
});

test('409：码有效但账号存储里没有这个账号，按 invalid_code 处理', async () => {
  const { code } = generateLoginCodes({ username: 'PvGhost' });

  const result = await call({ body: { code, gameId: 'PvGhost', uuid: UUID } });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { ok: false, reason: 'invalid_code' });
});

test('409：账号不存在时不烧码，注册后同一个码仍可验证', async () => {
  const username = 'PvLate';
  const { code } = generateLoginCodes({ username });

  const before = await call({ body: { code, gameId: username, uuid: UUID } });
  assert.equal(before.status, 409);
  assert.deepEqual(before.body, { ok: false, reason: 'invalid_code' });

  // 账号存在性检查失败发生在 confirm 之前，码必须保持未使用
  await createAccount(username);
  const afterCall = await call({ body: { code, gameId: username, uuid: UUID } });
  assert.equal(afterCall.status, 200);
  assert.deepEqual(afterCall.body, {
    ok: true,
    account: { username, nickname: username, role: 'player' },
  });
});

test('429：同一游戏 ID 连续失败后返回 rate_limited、retryAfterMs 与 attemptsRemaining', async () => {
  await createAccount('PvRate');

  // 模块内默认上限是 5 次 / 5 分钟，前 5 次是 invalid_code，第 6 次才限流
  for (let index = 0; index < 5; index += 1) {
    const failed = await call({
      body: { code: `wrong-code-${index}`, gameId: 'PvRate', uuid: UUID },
    });
    assert.equal(failed.status, 409);
    assert.deepEqual(failed.body, { ok: false, reason: 'invalid_code' });
  }

  const limited = await call({ body: { code: 'wrong-code-6', gameId: 'PvRate', uuid: UUID } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.ok, false);
  assert.equal(limited.body.reason, 'rate_limited');
  assert.equal(typeof limited.body.retryAfterMs, 'number');
  assert.ok((limited.body.retryAfterMs as number) > 0);
  assert.equal(limited.body.attemptsRemaining, 0);
});

test('400/413/415：请求体大小、格式与字段类型都有明确拒绝', async () => {
  const nonJson = await call({
    contentType: 'text/plain',
    raw: JSON.stringify({ code: 'x', gameId: 'x', uuid: UUID }),
  });
  assert.equal(nonJson.status, 415);

  const malformed = await call({ raw: '{not json' });
  assert.equal(malformed.status, 400);

  const oversized = await call({ raw: 'x'.repeat(2048) });
  assert.equal(oversized.status, 413);

  for (const body of [
    { code: 123, gameId: 'PvAlice', uuid: UUID },
    { code: 'x', gameId: 42, uuid: UUID },
    { code: 'x', gameId: 'PvAlice', uuid: 'not-a-uuid' },
    { code: 'x', gameId: 'PvAlice' },
  ]) {
    const result = await call({ body });
    assert.equal(result.status, 400, `字段类型错误应返回 400：${JSON.stringify(body)}`);
  }
});