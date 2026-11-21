import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createApp } from '../src/app.ts';
import { closeDb } from '../src/db/database.ts';
import { registerAccount } from '../src/domain/accounts.ts';
import {
  addIssueReply,
  createIssue,
  updateIssueStatus,
  validateNewIssue,
} from '../src/domain/issues.ts';
import type { CookieJar } from '../src/http/cookie.ts';
import {
  SESSION_COOKIE,
  createSessionCookie,
} from '../src/http/session.ts';

/**
 * /api/issues 与 /api/admin/pending 的路由级契约。
 *
 * 议题提交接口按 IP 限流（5 次 / 10 分钟），所以大部分列表数据用领域函数
 * 直接种下，只为路由本身的断言保留少量真实 POST。待审议题的可见性规则
 * 是这一组测试的重点：匿名看不见，站务令牌和 admin 会话都看得见。
 */

const PUBLIC_ORIGIN = 'http://localhost:4324';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const SESSION_SECRET = 'test-session-secret-0123456789';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-issues-'));
process.env.HYDWIND_DATA_DIR = dataDir;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.ISSUE_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.PLUGIN_TOKEN = 'test-plugin-token-0123456789';
process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
delete process.env.HYDWIND_DB_PATH;

after(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const app = createApp();

const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
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

const staff = (): Record<string, string> => ({
  authorization: `Bearer ${ADMIN_TOKEN}`,
});

const sessionCookie = (username: string, role: 'admin' | 'player'): string => {
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

const validInput = {
  title: '登录按钮偶尔没反应',
  body: '点击登录后页面没有跳转，刷新一次又恢复正常，已经遇到三次。',
  author: 'AliceApi',
  category: 'bug',
};

const seed = async (overrides: Partial<typeof validInput> = {}) => {
  const parsed = validateNewIssue({ ...validInput, ...overrides });
  if (!parsed.ok) throw new Error(parsed.message);
  return createIssue(parsed.value);
};

test('POST /api/issues：提交成功进入 pending，匿名列表不可见，站务可见', async () => {
  const response = await postJson('/api/issues', validInput);
  assert.equal(response.status, 201);

  const body = (await response.json()) as {
    issue?: Record<string, unknown>;
    message?: unknown;
  };
  assert.ok(body.issue);
  assert.equal(body.issue.title, validInput.title);
  assert.equal(body.issue.status, 'pending');
  assert.equal(typeof body.issue.id, 'number');
  assert.equal(typeof body.issue.createdAt, 'string');
  assert.equal(body.message, '提交成功，通过审核后会公开在议题列表里');

  const publicList = await call('/api/issues');
  assert.equal(publicList.status, 200);
  assert.deepEqual(await publicList.json(), { issues: [] });

  const staffList = await call('/api/issues', { headers: staff() });
  const staffBody = (await staffList.json()) as {
    issues?: Array<Record<string, unknown>>;
  };
  const listed = staffBody.issues?.find((issue) => issue.id === body.issue?.id);
  assert.ok(listed);
  assert.equal(listed.replyCount, 0);
  assert.equal(listed.author, 'AliceApi');
  assert.equal(listed.category, 'bug');
  assert.equal('body' in listed, false, '列表只返回摘要字段');

  const root = await registerAccount({
    username: 'RootIssues',
    platformId: 'qq-root-issues',
    role: 'admin',
  });
  assert.equal(root.ok, true);

  const adminSession = await call('/api/issues', {
    headers: { cookie: sessionCookie('RootIssues', 'admin') },
  });
  const adminBody = (await adminSession.json()) as {
    issues?: Array<{ id?: unknown }>;
  };
  assert.ok(adminBody.issues?.some((issue) => issue.id === body.issue?.id));
});

test('POST /api/issues：标题 / 描述校验 422，坏 JSON 400', async () => {
  const tooShort = await postJson('/api/issues', {
    ...validInput,
    title: '三个字',
  });
  assert.equal(tooShort.status, 422);
  assert.equal(typeof ((await tooShort.json()) as { error?: unknown }).error, 'string');

  const bodyTooShort = await postJson('/api/issues', {
    ...validInput,
    body: '太短',
  });
  assert.equal(bodyTooShort.status, 422);

  const malformed = await postJson('/api/issues', '{');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: '请求体不是合法 JSON' });
});

test('全局请求体上限 1MiB：超限返回 JSON 413', async () => {
  const response = await call('/api/issues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1024 * 1024 + 1),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: '请求体太大' });
});

test('GET/PATCH /api/issues/:id：pending 隐藏、站务改状态、错误码', async () => {
  const pending = await seed({ title: '待审的议题标题' });

  const anonymous = await call(`/api/issues/${pending.id}`);
  assert.equal(anonymous.status, 404);
  assert.deepEqual(await anonymous.json(), { error: '议题不存在' });

  const visibleToStaff = await call(`/api/issues/${pending.id}`, {
    headers: staff(),
  });
  assert.equal(visibleToStaff.status, 200);
  const detail = (await visibleToStaff.json()) as {
    issue?: { id?: unknown; body?: unknown; replies?: unknown };
  };
  assert.equal(detail.issue?.id, pending.id);
  assert.equal(detail.issue?.body, validInput.body);
  assert.deepEqual(detail.issue?.replies, []);

  const invalidId = await call('/api/issues/abc');
  assert.equal(invalidId.status, 400);
  assert.deepEqual(await invalidId.json(), { error: '议题编号不合法' });

  const missing = await call('/api/issues/99999', { headers: staff() });
  assert.equal(missing.status, 404);

  const anonymousPatch = await call(`/api/issues/${pending.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'open' }),
  });
  assert.equal(anonymousPatch.status, 401);
  assert.deepEqual(await anonymousPatch.json(), { error: '需要站务权限' });

  const invalidStatus = await call(`/api/issues/${pending.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...staff() },
    body: JSON.stringify({ status: 'closed' }),
  });
  assert.equal(invalidStatus.status, 422);

  const opened = await call(`/api/issues/${pending.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...staff() },
    body: JSON.stringify({ status: 'open' }),
  });
  assert.equal(opened.status, 200);
  const openedBody = (await opened.json()) as {
    issue?: { status?: unknown };
  };
  assert.equal(openedBody.issue?.status, 'open');

  const publicDetail = await call(`/api/issues/${pending.id}`);
  assert.equal(publicDetail.status, 200);

  const patchedMissing = await call('/api/issues/99999', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...staff() },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(patchedMissing.status, 404);
});

test('GET/POST /api/issues/:id/replies：站务鉴权、长度校验与待审隐藏', async () => {
  const openIssue = await seed({ title: '可以公开回复的议题' });
  await updateIssueStatus(openIssue.id, 'open');

  const pendingIssue = await seed({ title: '带回复的待审议题' });
  assert.ok(
    await addIssueReply(pendingIssue.id, {
      author: '氢风站务',
      body: '待审回复',
      staff: true,
    })
  );

  const anonymousPost = await postJson(`/api/issues/${openIssue.id}/replies`, {
    body: '匿名回复',
  });
  assert.equal(anonymousPost.status, 401);

  const empty = await postJson(
    `/api/issues/${openIssue.id}/replies`,
    { body: '  ' },
    staff()
  );
  assert.equal(empty.status, 422);

  const tooLong = await postJson(
    `/api/issues/${openIssue.id}/replies`,
    { body: '字'.repeat(1001) },
    staff()
  );
  assert.equal(tooLong.status, 422);

  const posted = await postJson(
    `/api/issues/${openIssue.id}/replies`,
    { body: '已经在排查了', author: '氢风站务' },
    staff()
  );
  assert.equal(posted.status, 201);
  const postedBody = (await posted.json()) as {
    issue?: { replies?: Array<Record<string, unknown>> };
  };
  assert.equal(postedBody.issue?.replies?.length, 1);
  assert.equal(postedBody.issue?.replies?.[0]?.body, '已经在排查了');
  assert.equal(postedBody.issue?.replies?.[0]?.staff, true);

  const list = await call(`/api/issues/${openIssue.id}/replies`);
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { replies?: unknown[] };
  assert.equal(listBody.replies?.length, 1);

  const hidden = await call(`/api/issues/${pendingIssue.id}/replies`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: '议题不存在' });

  const visible = await call(`/api/issues/${pendingIssue.id}/replies`, {
    headers: staff(),
  });
  assert.equal(visible.status, 200);
  const visibleBody = (await visible.json()) as { replies?: unknown[] };
  assert.equal(visibleBody.replies?.length, 1);

  const invalid = await call('/api/issues/abc/replies');
  assert.equal(invalid.status, 400);
});

test('GET /api/admin/pending：只认站务令牌，只返回待审', async () => {
  const denied = await call('/api/admin/pending');
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: '需要站务令牌' });

  const wrong = await call('/api/admin/pending', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(wrong.status, 401);

  const response = await call('/api/admin/pending', { headers: staff() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    pending?: Array<{ status?: unknown; id?: unknown }>;
  };
  assert.ok(body.pending);
  assert.ok(body.pending.length > 0);
  assert.ok(body.pending.every((issue) => issue.status === 'pending'));
});

test('POST /api/issues：同一 IP 10 分钟最多 5 次', async () => {
  // 前面的用例已经消耗 4 次额度（成功 + 两个 422 + 一个坏 JSON），
  // 第 5 次仍放行，第 6 次应被限流。
  const fifth = await postJson('/api/issues', {
    ...validInput,
    title: '第五个议题标题',
  });
  assert.equal(fifth.status, 201);

  const limited = await postJson('/api/issues', {
    ...validInput,
    title: '第六个议题标题',
  });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    error: '提交太频繁啦，休息几分钟再试',
  });
});