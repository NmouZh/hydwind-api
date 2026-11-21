import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { registerAccount } from '../src/domain/accounts.ts';
import { findBiographyByGameId, updateBiography } from '../src/domain/biographies.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import { SESSION_COOKIE, createSessionCookie } from '../src/http/session.ts';

/**
 * 新增的 GET /api/people 与 GET /api/people/:id 的契约。
 *
 * 内容目录指向仓库内 fixture（CI 里没有兄弟仓库 hydwind-web），所以静态人物
 * 固定是 `nz-173`。/people 列表是静态人物与注册账号的合并视图；详情接口把
 * 传记、评论和 viewer 权限一次性返回给 Web SSR / 启动器。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-people-'));
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

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  app.request(`${PUBLIC_ORIGIN}${path}`, init);

const postJson = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const account = async (
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

test('GET /api/people：合并静态人物与账号，按 gameId 排序并支持 q 搜索', async () => {
  await account('ListAlice', { nickname: '爱丽丝' });
  await account('ListBob', { nickname: '小波' });
  const saved = await updateBiography('ListAlice', {
    mainTitle: '爱丽丝的传记',
    body: '你好，世界',
  });
  assert.equal(saved.ok, true);

  const response = await call('/api/people');
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    people?: Array<Record<string, unknown>>;
  };
  assert.ok(body.people);
  assert.deepEqual(
    body.people.map((person) => person.gameId),
    ['ListAlice', 'ListBob', 'Nz_173']
  );

  const alice = body.people.find((person) => person.gameId === 'ListAlice');
  assert.deepEqual(alice, {
    slug: 'listalice',
    gameId: 'ListAlice',
    nickname: '爱丽丝',
    mainTitle: '爱丽丝的传记',
    avatar: '/api/avatar/ListAlice',
    role: '',
    tags: [],
    hasBody: true,
    updatedAt: saved.ok ? saved.value.updatedAt : null,
    commentCount: 0,
    source: 'account',
  });

  const staticPerson = body.people.find((person) => person.gameId === 'Nz_173');
  assert.deepEqual(staticPerson, {
    slug: 'nz-173',
    gameId: 'Nz_173',
    nickname: '',
    mainTitle: 'Nz_173的人物传记',
    avatar: '/images/nz-173.png',
    role: '服主',
    tags: ['运维'],
    hasBody: true,
    updatedAt: '2026-10-31',
    commentCount: 0,
    source: 'static',
  });

  const byNickname = (await (
    await call('/api/people?q=%E7%88%B1')
  ).json()) as { people?: Array<{ gameId?: unknown }> };
  assert.deepEqual(
    byNickname.people?.map((person) => person.gameId),
    ['ListAlice']
  );

  const byGameId = (await (await call('/api/people?q=NZ_173')).json()) as {
    people?: Array<{ gameId?: unknown }>;
  };
  assert.deepEqual(
    byGameId.people?.map((person) => person.gameId),
    ['Nz_173']
  );

  const empty = (await (await call('/api/people?q=nobody')).json()) as {
    people?: unknown[];
  };
  assert.deepEqual(empty.people, []);
});

test('GET /api/people/:id：静态人物没有运行期传记时 biography 为 null', async () => {
  const response = await call('/api/people/nz-173');
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body.person, {
    slug: 'nz-173',
    gameId: 'Nz_173',
    source: 'static',
    personId: 'nz-173',
  });
  assert.equal(body.biography, null);
  assert.deepEqual(body.comments, []);
  assert.equal(body.viewer, null);
  assert.equal(body.canEdit, false);

  const missing = await call('/api/people/nobody-person');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: '没有这个人物' });
});

test('GET /api/people/:id：账号来源确保传记存在，viewer 与 canEdit 按实时角色', async () => {
  await account('DetailNoBio', { nickname: '无传记者' });
  await account('DetailOwner', { nickname: '详情主人' });
  await account('DetailOther', { nickname: '路人' });
  await account('DetailRoot', { role: 'admin' });

  const anonymous = await call('/api/people/detailnobio');
  assert.equal(anonymous.status, 200);
  const anonymousBody = (await anonymous.json()) as {
    person?: Record<string, unknown>;
    biography?: Record<string, unknown> | null;
    viewer?: unknown;
    canEdit?: unknown;
  };
  assert.deepEqual(anonymousBody.person, {
    slug: 'detailnobio',
    gameId: 'DetailNoBio',
    source: 'account',
  });
  assert.ok(anonymousBody.biography);
  assert.equal(anonymousBody.biography?.mainTitle, 'DetailNoBio的人物传记');
  assert.equal(anonymousBody.biography?.body, '');
  assert.equal(typeof anonymousBody.biography?.createdAt, 'string');
  assert.equal(typeof anonymousBody.biography?.updatedAt, 'string');
  assert.equal(anonymousBody.viewer, null);
  assert.equal(anonymousBody.canEdit, false);

  // 账号来源的 GET 会 ensure 一篇传记：注册账号不再出现「没有传记」的缝隙。
  assert.ok(await findBiographyByGameId('DetailNoBio'));

  const saved = await updateBiography('DetailOwner', {
    mainTitle: '详情主人的传记',
    body: '这是正文',
  });
  assert.equal(saved.ok, true);

  const owner = await call('/api/people/detailowner', {
    headers: { cookie: sessionCookie('DetailOwner') },
  });
  const ownerBody = (await owner.json()) as {
    biography?: { mainTitle?: unknown };
    viewer?: Record<string, unknown>;
    canEdit?: unknown;
  };
  assert.equal(ownerBody.biography?.mainTitle, '详情主人的传记');
  assert.deepEqual(ownerBody.viewer, {
    username: 'DetailOwner',
    nickname: '详情主人',
    role: 'player',
  });
  assert.equal(ownerBody.canEdit, true);

  const other = await call('/api/people/detailowner', {
    headers: { cookie: sessionCookie('DetailOther') },
  });
  const otherBody = (await other.json()) as {
    viewer?: Record<string, unknown>;
    canEdit?: unknown;
  };
  assert.equal(otherBody.viewer?.username, 'DetailOther');
  assert.equal(otherBody.canEdit, false);

  const admin = await call('/api/people/detailowner', {
    headers: { cookie: sessionCookie('DetailRoot') },
  });
  const adminBody = (await admin.json()) as {
    viewer?: { role?: unknown };
    canEdit?: unknown;
  };
  assert.equal(adminBody.viewer?.role, 'admin');
  assert.equal(adminBody.canEdit, true);

  const ghost = await call('/api/people/detailowner', {
    headers: { cookie: sessionCookie('GhostPerson') },
  });
  const ghostBody = (await ghost.json()) as {
    viewer?: unknown;
    canEdit?: unknown;
  };
  assert.equal(ghostBody.viewer, null);
  assert.equal(ghostBody.canEdit, false);
});

test('GET /api/people/:id：评论按作者本人 / 管理员精确给出 canDelete', async () => {
  await account('CommentAlice', { nickname: '评论主人' });
  await account('CommentBob', { nickname: '鲍勃' });
  await account('CommentCarol', { nickname: '卡罗尔' });
  await account('CommentRoot', { role: 'admin' });
  const saved = await updateBiography('CommentAlice', {
    mainTitle: '评论主人的传记',
    body: '',
  });
  assert.equal(saved.ok, true);

  const first = await postJson(
    '/api/people/commentalice/comments',
    { body: '第一条' },
    { cookie: sessionCookie('CommentBob') }
  );
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as {
    comment?: { id?: unknown };
  };

  const second = await postJson(
    '/api/people/commentalice/comments',
    { body: '第二条' },
    { cookie: sessionCookie('CommentCarol') }
  );
  assert.equal(second.status, 201);
  const secondBody = (await second.json()) as {
    comment?: { id?: unknown };
  };

  const asBob = (await (
    await call('/api/people/commentalice', {
      headers: { cookie: sessionCookie('CommentBob') },
    })
  ).json()) as {
    comments?: Array<Record<string, unknown>>;
    canEdit?: unknown;
    viewer?: { username?: unknown };
  };
  assert.equal(asBob.viewer?.username, 'CommentBob');
  assert.equal(asBob.canEdit, false, '评论者不是传记主人');
  assert.deepEqual(
    asBob.comments?.map((comment) => ({
      body: comment.body,
      canDelete: comment.canDelete,
    })),
    [
      { body: '第一条', canDelete: true },
      { body: '第二条', canDelete: false },
    ]
  );
  assert.equal(asBob.comments?.[0]?.authorDisplay, '鲍勃');
  assert.equal(asBob.comments?.[0]?.authorGameId, 'CommentBob');

  const asOwner = (await (
    await call('/api/people/commentalice', {
      headers: { cookie: sessionCookie('CommentAlice') },
    })
  ).json()) as { comments?: Array<{ canDelete?: unknown }> };
  assert.deepEqual(
    asOwner.comments?.map((comment) => comment.canDelete),
    [false, false],
    '传记主人不能删别人的评论'
  );

  const asAdmin = (await (
    await call('/api/people/commentalice', {
      headers: { cookie: sessionCookie('CommentRoot') },
    })
  ).json()) as { comments?: Array<{ canDelete?: unknown }> };
  assert.deepEqual(
    asAdmin.comments?.map((comment) => comment.canDelete),
    [true, true]
  );

  const denied = await call(
    `/api/people/commentalice/comments/${String(firstBody.comment?.id)}`,
    {
      method: 'DELETE',
      headers: { cookie: sessionCookie('CommentCarol') },
    }
  );
  assert.equal(denied.status, 403);

  const removed = await call(
    `/api/people/commentalice/comments/${String(firstBody.comment?.id)}`,
    {
      method: 'DELETE',
      headers: { cookie: sessionCookie('CommentBob') },
    }
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: true });

  const adminRemoved = await call(
    `/api/people/commentalice/comments/${String(secondBody.comment?.id)}`,
    {
      method: 'DELETE',
      headers: { cookie: sessionCookie('CommentRoot') },
    }
  );
  assert.equal(adminRemoved.status, 200);

  const afterDelete = (await (
    await call('/api/people/commentalice')
  ).json()) as { comments?: unknown[] };
  assert.deepEqual(afterDelete.comments, []);

  const unknownComment = await call(
    '/api/people/commentalice/comments/missing-comment',
    {
      method: 'DELETE',
      headers: { cookie: sessionCookie('CommentBob') },
    }
  );
  assert.equal(unknownComment.status, 404);
});

test('静态人物收到评论后仍有静态身份，biography 变为运行期记录', async () => {
  await account('StaticFan', { nickname: '服主粉丝' });

  const posted = await postJson(
    '/api/people/nz-173/comments',
    { body: '给服主留言' },
    { cookie: sessionCookie('StaticFan') }
  );
  assert.equal(posted.status, 201);

  const response = await call('/api/people/nz-173', {
    headers: { cookie: sessionCookie('StaticFan') },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    person?: Record<string, unknown>;
    biography?: Record<string, unknown> | null;
    comments?: Array<Record<string, unknown>>;
    canEdit?: unknown;
  };

  assert.deepEqual(body.person, {
    slug: 'nz-173',
    gameId: 'Nz_173',
    source: 'static',
    personId: 'nz-173',
  });
  assert.ok(body.biography);
  assert.equal(body.biography?.gameId, 'Nz_173');
  assert.equal(body.comments?.length, 1);
  assert.equal(body.comments?.[0]?.body, '给服主留言');
  assert.equal(body.comments?.[0]?.authorDisplay, '服主粉丝');
  assert.equal(body.comments?.[0]?.canDelete, true);
  assert.equal(body.canEdit, false, '评论者不能编辑服主的传记');
});