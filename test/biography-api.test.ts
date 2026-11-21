import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { registerAccount } from '../src/domain/accounts.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import { SESSION_COOKIE, createSessionCookie } from '../src/http/session.ts';

/**
 * GET/PUT /api/people/:id/biography 的 HTTP 契约（原 hydwind-web 用例的
 * 路由级移植）。slug 解析、会话校验、账号回查、同源与参数校验全部走
 * createApp().request，不监听端口。
 *
 * 账号通过领域层注册（不自动 ensure 传记），以保留「还没有记录 → 默认空
 * 传记」这条原契约；注册接口本身会自动建传记，见 auth-api.test.ts。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-biography-'));
process.env.HYDWIND_DATA_DIR = dataDir;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.ISSUE_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.PLUGIN_TOKEN = 'test-plugin-token-0123456789';
process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
process.env.HYDWIND_CONTENT_DIR = path.join(import.meta.dirname, 'fixtures', 'content');
delete process.env.HYDWIND_DB_PATH;

after(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const app = createApp();

const createAccount = async (
  username: string,
  role: 'admin' | 'player' = 'player'
): Promise<void> => {
  const result = await registerAccount({
    username,
    platformId: `qq-${username}`,
    role,
  });
  assert.equal(result.ok, true, `测试账号创建失败：${username}`);
};

/** 生成与登录接口一致的签名 cookie；路由会按 username 回查账号，不信任 cookie 里的 role。 */
const sessionCookie = (username: string, role: 'admin' | 'player' = 'player'): string => {
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

interface CallOptions {
  cookie?: string;
  body?: unknown;
  raw?: string;
  /** 传 null 表示不带 content-type */
  contentType?: string | null;
  /** 浏览器写操作会带 Origin；不传模拟 curl 这类同源豁免调用。 */
  origin?: string;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

const call = async (
  method: 'GET' | 'PUT',
  slug: string,
  options: CallOptions = {}
): Promise<CallResult> => {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  const requestBody =
    method === 'GET'
      ? undefined
      : options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

  const response = await app.request(
    `${PUBLIC_ORIGIN}/api/people/${encodeURIComponent(slug)}/biography`,
    { method, headers, body: requestBody }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const char = (length: number): string => '字'.repeat(length);

test('GET：公开可读；账号还没有记录时返回默认空传记', async () => {
  await createAccount('BioEmpty');

  const result = await call('GET', 'bioempty');

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    gameId: 'BioEmpty',
    mainTitle: 'BioEmpty的人物传记',
    body: '',
    canEdit: false,
    updatedAt: null,
  });
});

test('GET：本人 canEdit 为 true，其他登录用户与游客为 false', async () => {
  await createAccount('BioOwnerAlice');
  await createAccount('BioOwnerBob');

  const anonymous = await call('GET', 'bioowneralice');
  assert.equal(anonymous.body.canEdit, false);

  const owner = await call('GET', 'BIOOWNERALICE', {
    cookie: sessionCookie('BioOwnerAlice'),
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.gameId, 'BioOwnerAlice');
  assert.equal(owner.body.canEdit, true);

  const other = await call('GET', 'bioowneralice', {
    cookie: sessionCookie('BioOwnerBob'),
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.canEdit, false);
});

test('GET：管理员对任意合法人物 canEdit 为 true', async () => {
  await createAccount('BioOwnerAlice');
  await createAccount('BioAdminRoot', 'admin');

  const result = await call('GET', 'bioowneralice', {
    cookie: sessionCookie('BioAdminRoot', 'admin'),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.canEdit, true);
});

test('GET：未知 slug 返回 404；静态人物 slug 也能解析', async () => {
  const missing = await call('GET', 'nobody');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, 'string');

  const staticPerson = await call('GET', 'nz-173');
  assert.equal(staticPerson.status, 200);
  assert.equal(staticPerson.body.gameId, 'Nz_173');
  assert.equal(staticPerson.body.mainTitle, 'Nz_173的人物传记');
  assert.equal(staticPerson.body.updatedAt, null);
});

test('PUT：未登录返回 401，不写任何记录', async () => {
  await createAccount('BioUnauth');

  const result = await call('PUT', 'biounauth', {
    body: { mainTitle: '爱丽丝', body: '你好' },
  });
  assert.equal(result.status, 401);

  const afterCall = await call('GET', 'biounauth');
  assert.equal(afterCall.body.updatedAt, null);
});

test('PUT：本人可以创建第一篇，并读回保存后的内容', async () => {
  await createAccount('BioCreate');

  const saved = await call('PUT', 'biocreate', {
    cookie: sessionCookie('BioCreate'),
    body: { mainTitle: '爱丽丝', body: '你好，世界' },
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.gameId, 'BioCreate');
  assert.equal(saved.body.mainTitle, '爱丽丝');
  assert.equal(saved.body.body, '你好，世界');
  assert.equal(typeof saved.body.updatedAt, 'string');
  assert.equal(saved.body.canEdit, true);
  assert.equal(saved.body.message, '传记保存好了');

  const read = await call('GET', 'biocreate');
  assert.equal(read.status, 200);
  assert.deepEqual(
    {
      gameId: read.body.gameId,
      mainTitle: read.body.mainTitle,
      body: read.body.body,
      updatedAt: read.body.updatedAt,
    },
    {
      gameId: 'BioCreate',
      mainTitle: '爱丽丝',
      body: '你好，世界',
      updatedAt: saved.body.updatedAt,
    }
  );
});

test('PUT：其他登录用户不能创建别人的第一篇（修复旧权限洞）', async () => {
  await createAccount('BioOther');
  await createAccount('BioOtherWriter');

  const denied = await call('PUT', 'bioother', {
    cookie: sessionCookie('BioOtherWriter'),
    body: { mainTitle: '抢注', body: '不是我的传记' },
  });

  assert.equal(denied.status, 403);

  const afterCall = await call('GET', 'bioother');
  assert.equal(afterCall.body.mainTitle, 'BioOther的人物传记');
  assert.equal(afterCall.body.body, '');
  assert.equal(afterCall.body.updatedAt, null);
});

test('PUT：管理员可以编辑他人传记', async () => {
  await createAccount('BioAdminTarget');
  await createAccount('BioAdminEdit', 'admin');

  const result = await call('PUT', 'bioadmintarget', {
    cookie: sessionCookie('BioAdminEdit', 'admin'),
    body: { mainTitle: '管理员改的标题', body: '整理过的正文' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mainTitle, '管理员改的标题');
  assert.equal(result.body.body, '整理过的正文');
});

test('PUT：标题 2–40 字、正文 0–4000 字；空标题回退默认标题', async () => {
  await createAccount('BioLimits');
  const cookie = sessionCookie('BioLimits');

  const tooShort = await call('PUT', 'biolimits', {
    cookie,
    body: { mainTitle: '一', body: '' },
  });
  assert.equal(tooShort.status, 400);

  const tooLong = await call('PUT', 'biolimits', {
    cookie,
    body: { mainTitle: char(41), body: '' },
  });
  assert.equal(tooLong.status, 400);

  const bodyTooLong = await call('PUT', 'biolimits', {
    cookie,
    body: { mainTitle: '爱丽丝', body: char(4001) },
  });
  assert.equal(bodyTooLong.status, 400);

  const cleared = await call('PUT', 'biolimits', {
    cookie,
    body: { mainTitle: '   ', body: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.mainTitle, 'BioLimits的人物传记');
  assert.equal(cleared.body.body, '');

  // 边界值可以保存
  const maxTitle = await call('PUT', 'biolimits', {
    cookie,
    body: { mainTitle: char(40), body: char(4000) },
  });
  assert.equal(maxTitle.status, 200);
});

test('PUT：非 JSON、坏 JSON、非对象请求体分别返回 415 / 400', async () => {
  await createAccount('BioFormats');
  const cookie = sessionCookie('BioFormats');

  const wrongType = await call('PUT', 'bioformats', {
    cookie,
    contentType: 'text/plain',
    raw: JSON.stringify({ mainTitle: '爱丽丝', body: '' }),
  });
  assert.equal(wrongType.status, 415);

  const malformed = await call('PUT', 'bioformats', { cookie, raw: '{not json' });
  assert.equal(malformed.status, 400);

  const notObject = await call('PUT', 'bioformats', { cookie, raw: '"hello"' });
  assert.equal(notObject.status, 400);
});

test('PUT：已登录但 slug 不存在返回 404', async () => {
  await createAccount('BioUnknownUser');

  const result = await call('PUT', 'nobody', {
    cookie: sessionCookie('BioUnknownUser'),
    body: { mainTitle: '爱丽丝', body: '' },
  });

  assert.equal(result.status, 404);
});

test('PUT：跨站 Origin 返回 403；同源与无 Origin 放行', async () => {
  await createAccount('BioOriginUser');
  const cookie = sessionCookie('BioOriginUser');

  const crossed = await call('PUT', 'bioriginuser', {
    cookie,
    origin: 'https://evil.example',
    body: { mainTitle: '跨站写入', body: '不应成功' },
  });
  assert.equal(crossed.status, 403);

  const afterCrossed = await call('GET', 'bioriginuser');
  assert.equal(afterCrossed.body.updatedAt, null);
  assert.equal(afterCrossed.body.body, '');

  const sameOrigin = await call('PUT', 'bioriginuser', {
    cookie,
    origin: PUBLIC_ORIGIN,
    body: { mainTitle: '同源写入', body: '可以成功' },
  });
  assert.equal(sameOrigin.status, 200);

  const noOrigin = await call('PUT', 'bioriginuser', {
    cookie,
    body: { mainTitle: '无 Origin 写入', body: '服务端调用' },
  });
  assert.equal(noOrigin.status, 200);
});

test('PUT：正文首尾的空行原样保留，只在判断空正文和长度时 trim', async () => {
  await createAccount('BioWhitespace');
  const cookie = sessionCookie('BioWhitespace');
  const body = '\n\n第一段\n\n第二段\n\n';

  const saved = await call('PUT', 'biowhitespace', {
    cookie,
    body: { mainTitle: '爱丽丝', body },
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.body, body);

  const read = await call('GET', 'biowhitespace');
  assert.equal(read.body.body, body);
});