import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { registerAccount, setAccountRole } from '../src/domain/accounts.ts';
import { ensureBiographyForAccount } from '../src/domain/biographies.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import { SESSION_COOKIE, createSessionCookie } from '../src/http/session.ts';

/**
 * GET/POST /api/people/:id/comments 与 DELETE /api/people/:id/comments/:cid
 * 的路由级契约（原 hydwind-web 用例的移植）。
 *
 * 公开 seam 仍是 HTTP：slug 解析、会话回查、同源校验、限流和权限判断都在
 * 路由里完成。内容目录用仓库内 fixture，CI 不依赖兄弟仓库 hydwind-web。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-comments-'));
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

const account = async (
  username: string,
  nickname = '',
  role: 'player' | 'admin' = 'player'
): Promise<void> => {
  const result = await registerAccount({
    username,
    nickname,
    role,
    platformId: `qq-${username}`,
  });
  assert.equal(result.ok, true, `测试账号创建失败：${username}`);
};

const sessionCookie = (
  username: string,
  role: 'player' | 'admin' = 'player'
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

interface Result {
  status: number;
  body: Record<string, any>;
  headers: Headers;
}

const call = async (
  method: 'GET' | 'POST' | 'DELETE',
  slug: string,
  options: {
    actor?: string;
    role?: 'player' | 'admin';
    payload?: unknown;
    raw?: string;
    cid?: string;
    origin?: string;
    contentType?: string | null;
  } = {}
): Promise<Result> => {
  const url = `${PUBLIC_ORIGIN}/api/people/${encodeURIComponent(slug)}/comments${
    options.cid ? `/${encodeURIComponent(options.cid)}` : ''
  }`;
  const headers: Record<string, string> = {};
  if (options.actor) headers.cookie = sessionCookie(options.actor, options.role);
  if (method === 'POST' && options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  if (options.origin) headers.origin = options.origin;

  const response = await app.request(url, {
    method,
    headers,
    body:
      method === 'POST'
        ? options.raw ?? JSON.stringify(options.payload)
        : undefined,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
    headers: response.headers,
  };
};

test('游客可按时间正序读取静态人物与账号 slug 的评论；昵称实时回查', async () => {
  await account('Nz_173');
  await account('CmtBob', '小波');
  await account('CmtCarol');
  await ensureBiographyForAccount({ username: 'Nz_173' });

  const first = await call('POST', 'nz-173', {
    actor: 'CmtBob',
    payload: { body: '第一条' },
  });
  const second = await call('POST', 'nz_173', {
    actor: 'CmtCarol',
    payload: { body: '第二条' },
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.ok(first.body.comment.id);
  assert.ok(second.body.comment.id);

  const result = await call('GET', 'nz-173');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.comments, [
    {
      id: first.body.comment.id,
      authorGameId: 'CmtBob',
      authorDisplay: '小波',
      body: '第一条',
      createdAt: first.body.comment.createdAt,
    },
    {
      id: second.body.comment.id,
      authorGameId: 'CmtCarol',
      authorDisplay: 'CmtCarol',
      body: '第二条',
      createdAt: second.body.comment.createdAt,
    },
  ]);
  assert.ok(
    Date.parse(first.body.comment.createdAt) <=
      Date.parse(second.body.comment.createdAt)
  );
});

test('POST 未登录 401；空白、非字符串、超 500 字和坏 JSON 为 400，且不占额度', async () => {
  await account('CmtHostOne');
  await account('CmtWriterOne');
  await ensureBiographyForAccount({ username: 'CmtHostOne' });

  assert.equal(
    (await call('POST', 'cmthostone', { payload: { body: '匿名留言' } })).status,
    401
  );

  for (const payload of [{ body: '' }, { body: '  ' }, { body: 12 }, { body: '字'.repeat(501) }]) {
    assert.equal(
      (await call('POST', 'cmthostone', { actor: 'CmtWriterOne', payload })).status,
      400
    );
  }

  assert.equal(
    (await call('POST', 'cmthostone', { actor: 'CmtWriterOne', raw: '{' })).status,
    400
  );

  const valid = await call('POST', 'cmthostone', {
    actor: 'CmtWriterOne',
    payload: { body: ' 好 ' },
  });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.comment.body, '好');
  assert.equal((await call('GET', 'cmthostone')).body.comments.length, 1);
});

test('未知 slug 的 GET/POST/DELETE 为 404；已注册账号没有传记时读空评论', async () => {
  await account('CmtWriterTwo');
  await account('CmtPendingTwo');

  assert.deepEqual((await call('GET', 'cmtpendingtwo')).body.comments, []);
  assert.equal((await call('GET', 'nobody')).status, 404);
  assert.equal(
    (await call('POST', 'nobody', { actor: 'CmtWriterTwo', payload: { body: 'hi' } }))
      .status,
    404
  );
  assert.equal(
    (await call('DELETE', 'nobody', { actor: 'CmtWriterTwo', cid: 'missing' })).status,
    404
  );
});

test('账号还没有运行期传记时，POST 先建空传记再添加评论而不是 404', async () => {
  await account('CmtWriterThree');
  await account('CmtPendingThree');

  assert.deepEqual((await call('GET', 'cmtpendingthree')).body.comments, []);

  const posted = await call('POST', 'cmtpendingthree', {
    actor: 'CmtWriterThree',
    payload: { body: '先建再评' },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.comment.body, '先建再评');

  const listed = await call('GET', 'cmtpendingthree');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.comments.map((comment: { body: string }) => comment.body),
    ['先建再评']
  );

  // 静态人物同样先 ensure 再评论（fixture 里 nz-173 是静态人物）。
  const staticPost = await call('POST', 'nz-173', {
    actor: 'CmtWriterThree',
    payload: { body: '给服主留言' },
  });
  assert.equal(staticPost.status, 201);
  assert.equal(
    (await call('GET', 'nz-173')).body.comments.some(
      (comment: { body: string }) => comment.body === '给服主留言'
    ),
    true
  );
});

test('每账号跨人物 10 分钟最多 5 条，第 6 条 429 且 GET 不含失败的评论', async () => {
  await account('CmtHostA');
  await account('CmtHostB');
  await account('CmtChatter');
  await ensureBiographyForAccount({ username: 'CmtHostA' });
  await ensureBiographyForAccount({ username: 'CmtHostB' });

  for (let index = 0; index < 5; index += 1) {
    const target = index % 2 ? 'cmthostb' : 'cmthosta';
    const posted = await call('POST', target, {
      actor: 'CmtChatter',
      payload: { body: `第${index + 1}条` },
    });
    assert.equal(posted.status, 201);
  }

  const limited = await call('POST', 'cmthostb', {
    actor: 'CmtChatter',
    payload: { body: '第六条' },
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await call('GET', 'cmthostb')).body.comments.length, 2);
});

test('DELETE 作者可删，非作者 403，管理员可删；以账号实时角色为准', async () => {
  await account('CmtHostFour');
  await account('CmtAuthorFour');
  await account('CmtOtherFour');
  await account('CmtModFour', '', 'admin');
  await ensureBiographyForAccount({ username: 'CmtHostFour' });

  const first = await call('POST', 'cmthostfour', {
    actor: 'CmtAuthorFour',
    payload: { body: '我要撤回' },
  });
  assert.equal(first.status, 201);
  const cid = first.body.comment.id;

  assert.equal((await call('DELETE', 'cmthostfour', { cid })).status, 401);
  assert.equal(
    (await call('DELETE', 'cmthostfour', { actor: 'CmtOtherFour', cid })).status,
    403
  );
  // cookie 里伪造 admin，但账号存储里是 player
  assert.equal(
    (
      await call('DELETE', 'cmthostfour', {
        actor: 'CmtOtherFour',
        role: 'admin',
        cid,
      })
    ).status,
    403
  );
  assert.equal(
    (await call('DELETE', 'cmthostfour', { actor: 'CmtAuthorFour', cid })).status,
    200
  );
  assert.deepEqual((await call('GET', 'cmthostfour')).body.comments, []);
  assert.equal(
    (await call('DELETE', 'cmthostfour', { actor: 'CmtAuthorFour', cid })).status,
    404
  );

  const second = await call('POST', 'cmthostfour', {
    actor: 'CmtAuthorFour',
    payload: { body: '管理员删' },
  });
  assert.equal(second.status, 201);
  assert.equal(
    (
      await call('DELETE', 'cmthostfour', {
        actor: 'CmtModFour',
        role: 'player',
        cid: second.body.comment.id,
      })
    ).status,
    200
  );
  assert.deepEqual((await call('GET', 'cmthostfour')).body.comments, []);

  const third = await call('POST', 'cmthostfour', {
    actor: 'CmtAuthorFour',
    payload: { body: '降权之后不能删' },
  });
  assert.equal(third.status, 201);
  assert.equal(await setAccountRole('CmtModFour', 'player'), true);
  assert.equal(
    (
      await call('DELETE', 'cmthostfour', {
        actor: 'CmtModFour',
        role: 'admin',
        cid: third.body.comment.id,
      })
    ).status,
    403
  );
});

test('跨站 Origin 的写操作均 403，不能使用登录 cookie 跨站发帖或删除', async () => {
  await account('CmtHostFive');
  await account('CmtAuthorFive');
  await ensureBiographyForAccount({ username: 'CmtHostFive' });

  assert.equal(
    (
      await call('POST', 'cmthostfive', {
        actor: 'CmtAuthorFive',
        payload: { body: '跨站' },
        origin: 'https://other.example',
      })
    ).status,
    403
  );

  const posted = await call('POST', 'cmthostfive', {
    actor: 'CmtAuthorFive',
    payload: { body: '本人评论' },
  });
  assert.equal(posted.status, 201);

  assert.equal(
    (
      await call('DELETE', 'cmthostfive', {
        actor: 'CmtAuthorFive',
        cid: posted.body.comment.id,
        origin: 'https://other.example',
      })
    ).status,
    403
  );
  assert.equal((await call('GET', 'cmthostfive')).body.comments.length, 1);

  // 同源 Origin 和没有 Origin 的服务端调用照常放行。
  const sameOrigin = await call('POST', 'cmthostfive', {
    actor: 'CmtAuthorFive',
    payload: { body: '同源评论' },
    origin: PUBLIC_ORIGIN,
  });
  assert.equal(sameOrigin.status, 201);
});

test('POST 非 JSON 415、坏 JSON 400、非对象 400', async () => {
  await account('CmtHostSix');
  await account('CmtWriterSix');
  await ensureBiographyForAccount({ username: 'CmtHostSix' });

  const wrongType = await call('POST', 'cmthostsix', {
    actor: 'CmtWriterSix',
    contentType: 'text/plain',
    raw: JSON.stringify({ body: 'x' }),
  });
  assert.equal(wrongType.status, 415);

  const malformed = await call('POST', 'cmthostsix', {
    actor: 'CmtWriterSix',
    raw: '{',
  });
  assert.equal(malformed.status, 400);

  const notObject = await call('POST', 'cmthostsix', {
    actor: 'CmtWriterSix',
    raw: '"hello"',
  });
  assert.equal(notObject.status, 400);
});