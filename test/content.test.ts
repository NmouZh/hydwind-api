import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getPublishedPeople,
  getSite,
  HydwindContentError,
} from '../src/domain/content.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'content');

/** 临时内容目录：相对路径 → 文件内容。 */
const writeContentDir = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydwind-content-'));
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  return root;
};

const withContentDir = async <T>(dir: string, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.HYDWIND_CONTENT_DIR;
  process.env.HYDWIND_CONTENT_DIR = dir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HYDWIND_CONTENT_DIR;
    else process.env.HYDWIND_CONTENT_DIR = previous;
  }
};

test('getSite 解析 fixtures 的 site/info.md', async () => {
  const site = await withContentDir(FIXTURES, getSite);

  assert.deepEqual(site, {
    name: '氢风',
    tagline: '原版与插件生存的 Minecraft Java 服务器，暂时免费，正在筹备测试。',
    statusLabel: '测试筹备中',
    address: 'zzbgp2.coreyun.net:35282',
    host: 'zzbgp2.coreyun.net',
    port: 35282,
    clientVersions: '1.8.9 – 26.3',
    clientRequirement: '原版或插件生存客户端即可，不需要安装模组',
    versionNote: '支持的客户端版本以后可能调整，以本页和官方 QQ 群通知为准。',
    authentication: '离线服务器，不需要正版验证',
    pricing: '暂时免费',
    qqGroup: '1129694648',
    joinLimit: '没有白名单，服务器在线即可进入',
    testingNotice: '世界可能重置，重要建筑请自行备份',
    updated: '2026-10-31',
  });
});

test('getPublishedPeople 解析 fixtures 的 people/nz-173.md', async () => {
  const people = await withContentDir(FIXTURES, getPublishedPeople);

  assert.equal(people.length, 1);
  const person = people[0];
  assert.equal(person.id, 'nz-173');
  assert.deepEqual(person.data, {
    gameId: 'Nz_173',
    role: '服主',
    tags: ['运维'],
    order: 1,
    avatar: '/images/nz-173.png',
    updated: '2026-10-31',
    published: true,
  });
  assert.equal(person.body, 'Nz_173 是氢风的服主，负责服务器的运行与测试筹备。');
});

test('getPublishedPeople 按 order / gameId 排序，跳过未发布并补默认值', async (t) => {
  const dir = await writeContentDir({
    'people/one.md': [
      '---',
      'gameId: Alpha',
      'role: 管理',
      'order: 1',
      'tags:',
      '  - 运维',
      '  - 生存',
      'updated: 2026-01-01',
      '---',
      '',
      '第一篇正文。',
      '',
    ].join('\n'),
    'people/two.md': '---\ngameId: Gamma\norder: 1\n---\n',
    'people/three.md': '---\ngameId: Zeta\n---\n',
    'people/draft.md': '---\ngameId: Draft\norder: 0\npublished: false\n---\n不该出现\n',
    'people/quoted-draft.md': '---\ngameId: QuotedDraft\npublished: "false"\n---\n',
    'people/no-game-id.md': '---\nrole: 路人\n---\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const people = await withContentDir(dir, getPublishedPeople);

  assert.deepEqual(
    people.map((person) => person.id),
    ['one', 'two', 'three']
  );
  assert.deepEqual(
    people.map((person) => person.data.gameId),
    ['Alpha', 'Gamma', 'Zeta']
  );
  assert.deepEqual(people[0].data.tags, ['运维', '生存']);
  assert.equal(people[0].body, '第一篇正文。');

  assert.deepEqual(people[1].data.tags, []);
  assert.equal(people[1].data.order, 1);
  assert.equal(people[1].data.avatar, '/api/avatar/Gamma');
  assert.equal(people[1].data.updated, '');
  assert.equal(people[1].data.published, true);

  assert.equal(people[2].data.order, 999);
});

test('getPublishedPeople 在人物目录不存在时返回空数组', async (t) => {
  const dir = await writeContentDir({ 'site/info.md': '---\n---\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.deepEqual(await withContentDir(dir, getPublishedPeople), []);
});

test('getSite 在内容文件不存在时抛 HydwindContentError', async (t) => {
  const dir = await writeContentDir({});
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(withContentDir(dir, getSite), (error: unknown) => {
    assert.ok(error instanceof HydwindContentError);
    assert.equal(error.path, path.join(dir, 'site', 'info.md'));
    assert.match(error.message, /site[\\/]info\.md/);
    return true;
  });
});

test('getSite 缺少必填字段时抛 HydwindContentError', async (t) => {
  const dir = await writeContentDir({
    'site/info.md': [
      '---',
      'name: 氢风',
      'address: play.example.com:25565',
      'port: 25565',
      '---',
      '',
    ].join('\n'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(withContentDir(dir, getSite), (error: unknown) => {
    assert.ok(error instanceof HydwindContentError);
    assert.match(error.message, /host/);
    assert.match(error.message, /site[\\/]info\.md/);
    return true;
  });
});

test('坏 frontmatter（没有闭合 ---）抛 HydwindContentError', async (t) => {
  const dir = await writeContentDir({
    'site/info.md': '---\nname: 氢风\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(withContentDir(dir, getSite), (error: unknown) => {
    assert.ok(error instanceof HydwindContentError);
    assert.match(error.message, /frontmatter/);
    assert.match(error.message, /site[\\/]info\.md/);
    return true;
  });
});

test('坏 frontmatter（无法解析的行）抛 HydwindContentError', async (t) => {
  const dir = await writeContentDir({
    'site/info.md': '---\nname 氢风\n---\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(withContentDir(dir, getSite), (error: unknown) => {
    assert.ok(error instanceof HydwindContentError);
    assert.match(error.message, /无法解析/);
    assert.match(error.message, /site[\\/]info\.md/);
    return true;
  });
});