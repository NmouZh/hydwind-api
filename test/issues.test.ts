import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { closeDb } from '../src/db/database.ts';
import {
  ISSUE_CATEGORIES,
  ISSUE_STATUSES,
  addIssueReply,
  createIssue,
  getIssue,
  isIssueStatus,
  listIssues,
  updateIssueStatus,
  validateNewIssue,
} from '../src/domain/issues.ts';
import type { IssueCategory } from '../src/domain/issues.ts';

/**
 * 议题存储层（SQLite）。
 *
 * 旧版把 version/nextId 写在 JSON 里；现在 id 由 AUTOINCREMENT 生成。
 * 测试通过公开函数观察列表顺序、待审过滤和回复更新。
 */

const useTempDb = (t: TestContext): void => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-issue-'));
  const savedDbPath = process.env.HYDWIND_DB_PATH;
  const savedDataDir = process.env.HYDWIND_DATA_DIR;

  closeDb();
  process.env.HYDWIND_DB_PATH = path.join(dir, 'hydwind.sqlite');
  delete process.env.HYDWIND_DATA_DIR;

  t.after(() => {
    closeDb();
    if (savedDbPath === undefined) delete process.env.HYDWIND_DB_PATH;
    else process.env.HYDWIND_DB_PATH = savedDbPath;
    if (savedDataDir === undefined) delete process.env.HYDWIND_DATA_DIR;
    else process.env.HYDWIND_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  });
};

const validInput = {
  title: '登录按钮偶尔没反应',
  body: '点击登录后页面没有跳转，刷新一次又恢复正常，已经遇到三次。',
  author: 'Alice',
  category: 'bug' as IssueCategory,
};

const createFrom = async (overrides: Partial<typeof validInput> = {}) => {
  const validated = validateNewIssue({ ...validInput, ...overrides });
  if (!validated.ok) assert.fail(`测试输入应通过校验：${validated.message}`);
  return createIssue(validated.value);
};

test('关键词表保持旧值', () => {
  assert.deepEqual(ISSUE_CATEGORIES, ['bug', 'suggestion', 'other']);
  assert.deepEqual(ISSUE_STATUSES, ['pending', 'open', 'rejected', 'done']);
});

test('validateNewIssue：标题至少 4 字、描述至少 10 字', () => {
  const ok = validateNewIssue(validInput);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.value, {
    title: validInput.title,
    body: validInput.body,
    author: 'Alice',
    category: 'bug',
  });

  assert.equal(validateNewIssue({ ...validInput, title: '三个字' }).ok, false);
  assert.equal(validateNewIssue({ ...validInput, body: '太短了' }).ok, false);
});

test('validateNewIssue：作者缺省匿名玩家，未知分类归 other，字符串先 trim', () => {
  const anonymous = validateNewIssue({
    ...validInput,
    title: '  标题四个字  ',
    body: '  这是一段足够长的描述文字  ',
    author: '   ',
    category: 'unknown',
  });
  assert.equal(anonymous.ok, true);
  if (!anonymous.ok) return;
  assert.equal(anonymous.value.title, '标题四个字');
  assert.equal(anonymous.value.body, '这是一段足够长的描述文字');
  assert.equal(anonymous.value.author, '匿名玩家');
  assert.equal(anonymous.value.category, 'other');
});

test('createIssue 初始状态 pending，id 由数据库递增并返回 number', async (t) => {
  useTempDb(t);

  const first = await createFrom();
  const second = await createFrom({ title: '第二条议题标题' });

  assert.equal(typeof first.id, 'number');
  assert.equal(typeof second.id, 'number');
  assert.ok(second.id > first.id);
  assert.equal(first.status, 'pending');
  assert.equal(first.category, 'bug');
  assert.deepEqual(first.replies, []);
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)));
  assert.equal(first.createdAt, first.updatedAt);
});

test('listIssues 默认过滤 pending，按 id 降序；includePending 返回全部', async (t) => {
  useTempDb(t);

  const first = await createFrom();
  const second = await createFrom({ title: '第二条议题标题' });
  const third = await createFrom({ title: '第三条议题标题' });

  assert.deepEqual(await listIssues(), []);

  await updateIssueStatus(first.id, 'open');
  await updateIssueStatus(second.id, 'rejected');

  const visible = await listIssues();
  assert.deepEqual(
    visible.map((issue) => issue.id),
    [second.id, first.id]
  );

  const all = await listIssues({ includePending: true });
  assert.deepEqual(
    all.map((issue) => issue.id),
    [third.id, second.id, first.id]
  );
});

test('getIssue 未知 id 返回 undefined，存在时带出回复', async (t) => {
  useTempDb(t);

  const issue = await createFrom();
  assert.equal(await getIssue(issue.id + 100), undefined);
  assert.equal(await getIssue(Number.NaN), undefined);

  const found = await getIssue(issue.id);
  assert.equal(found?.id, issue.id);
  assert.equal(found?.title, validInput.title);
  assert.equal(found?.body, validInput.body);
  assert.equal(found?.author, 'Alice');
});

test('updateIssueStatus 更新状态与 updated_at，未知 id 返回 undefined', async (t) => {
  useTempDb(t);

  const issue = await createFrom();
  const updated = await updateIssueStatus(issue.id, 'open');
  assert.equal(updated?.status, 'open');
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(issue.updatedAt));

  assert.equal(await updateIssueStatus(issue.id + 100, 'open'), undefined);

  const stored = await getIssue(issue.id);
  assert.equal(stored?.status, 'open');
  assert.equal(stored?.updatedAt, updated?.updatedAt);
});

test('addIssueReply 追加回复、staff 转布尔、按 id 升序并同步 updated_at', async (t) => {
  useTempDb(t);

  const issue = await createFrom();

  const afterFirst = await addIssueReply(issue.id, {
    author: '氢风站务',
    body: '已经在排查了',
    staff: true,
  });
  assert.equal(afterFirst?.replies.length, 1);

  const afterSecond = await addIssueReply(issue.id, {
    author: '氢风站务',
    body: '修好了，更新后重试',
  });

  assert.equal(afterSecond?.replies.length, 2);
  const replies = afterSecond?.replies ?? [];
  assert.ok(Number(replies[0].id) < Number(replies[1].id));
  assert.deepEqual(
    replies.map((reply) => reply.body),
    ['已经在排查了', '修好了，更新后重试']
  );
  assert.equal(replies[0].staff, true);
  assert.equal(replies[1].staff, false);
  assert.equal(replies[0].author, '氢风站务');
  assert.equal(replies[1].author, '氢风站务');
  assert.ok(Date.parse(afterSecond.updatedAt) >= Date.parse(issue.updatedAt));

  const stored = await getIssue(issue.id);
  assert.equal(stored?.replies.length, 2);
  assert.equal(stored?.updatedAt, afterSecond.updatedAt);

  assert.equal(await addIssueReply(issue.id + 100, { author: 'x', body: 'y' }), undefined);
});

test('addIssueReply 缺省作者写入空串', async (t) => {
  useTempDb(t);

  const issue = await createFrom();
  const withEmpty = await addIssueReply(issue.id, { author: '', body: '匿名回复' });
  assert.equal(withEmpty?.replies[0].author, '');

  // 运行时缺少 author 时同样按空串处理；公开签名仍要求 author。
  const missing = await addIssueReply(issue.id, { body: '缺字段回复' } as {
    author: string;
    body: string;
  });
  assert.equal(missing?.replies[1].author, '');
});

test('isIssueStatus 只认四个状态', () => {
  for (const status of ISSUE_STATUSES) assert.equal(isIssueStatus(status), true);
  for (const value of ['Open', 'closed', '', undefined, null, 1]) {
    assert.equal(isIssueStatus(value), false);
  }
});

test('议题与回复在 closeDb 后仍能重新读取（持久化）', async (t) => {
  useTempDb(t);

  const issue = await createFrom();
  await addIssueReply(issue.id, { author: '氢风站务', body: '持久化的回复', staff: true });

  closeDb();

  const reloaded = await getIssue(issue.id);
  assert.equal(reloaded?.title, validInput.title);
  assert.deepEqual(
    reloaded?.replies.map((reply) => reply.body),
    ['持久化的回复']
  );
  assert.equal(reloaded?.replies[0].author, '氢风站务');

  // AUTOINCREMENT 不因重连而回退。
  const next = await createFrom({ title: '重连后的新议题' });
  assert.ok(next.id > issue.id);
});