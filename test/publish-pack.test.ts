import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../scripts/publish-pack.ts';
import type { PublishPackCliOptions } from '../scripts/publish-pack.ts';
import { parseClientPackDraft, validateOverridesZip } from '../src/launcher/client-pack.ts';
import {
  PACK_PUBLISHER_USER_AGENT,
  buildOverridesPayload,
  defaultPackOutDir,
  parsePackSpec,
  publishClientPack,
  resolveClientPack,
  serializeClientPackDraft,
} from '../src/launcher/pack-publisher.ts';
import type { ClientPackSpec, ResolveClientPackOptions } from '../src/launcher/pack-publisher.ts';
import { readZipEntries } from '../src/launcher/zip.ts';
import { writeZipEntries } from '../src/launcher/zip-write.ts';

/**
 * 发布脚本测试：Modrinth 解析与依赖展开、overrides 确定性 zip、包自校验、
 * 管理接口上传与 CLI 退出码。
 *
 * 所有 fetch 都是假的，Modrinth 响应来自 `publish-pack-modrinth.json`；
 * 时钟固定，临时目录在测试内创建并清理。CI 不联网。
 */

const FIXED_NOW = new Date('2026-11-22T12:00:00Z');
const fixedNow = (): Date => new Date(FIXED_NOW.getTime());
const MODRINTH_BASE = 'https://api.modrinth.com/v2';

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/launcher/${name}`, import.meta.url), 'utf8');

const fixture = <T>(name: string): T => JSON.parse(fixtureText(name)) as T;

interface FixtureFile {
  hashes?: { sha512?: string };
  url?: string;
  filename?: string;
  primary?: boolean;
  size?: number;
}

interface FixtureDependency {
  project_id?: string;
  version_id?: string;
  dependency_type: string;
}

interface FixtureVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: string;
  date_published: string;
  game_versions: string[];
  loaders: string[];
  files: FixtureFile[];
  dependencies: FixtureDependency[];
}

interface FixtureProject {
  id: string;
  slug: string;
  title: string;
  client_side?: string;
}

interface ModrinthFixture {
  projects: Record<string, FixtureProject>;
  versions: Record<string, FixtureVersion[]>;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const loadFixture = (): ModrinthFixture =>
  fixture<ModrinthFixture>('publish-pack-modrinth.json');

const cloneFixture = (): ModrinthFixture =>
  JSON.parse(JSON.stringify(loadFixture())) as ModrinthFixture;

const versionIn = (
  data: ModrinthFixture,
  projectId: string,
  versionId: string
): FixtureVersion => {
  const found = data.versions[projectId]?.find((version) => version.id === versionId);
  if (!found) throw new Error(`fixture 缺少版本 ${projectId}/${versionId}`);
  return found;
};

/**
 * 假 Modrinth：按 URL 分派 `/project/{ref}`、`/project/{id}/version`、
 * `/version/{id}`。baseUrl 可换，用于验证镜像基址。
 */
const makeModrinthFetch = (
  data: ModrinthFixture,
  baseUrl = MODRINTH_BASE
): { fn: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const projectsById = new Map<string, FixtureProject>();
  const projectsBySlug = new Map<string, FixtureProject>();
  const versionsById = new Map<string, FixtureVersion>();

  for (const project of Object.values(data.projects)) {
    projectsById.set(project.id, project);
    projectsBySlug.set(project.slug, project);
  }
  for (const versions of Object.values(data.versions)) {
    for (const version of versions) versionsById.set(version.id, version);
  }

  const fn = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    });

    if (!url.startsWith(baseUrl)) throw new TypeError(`unexpected fetch: ${url}`);
    const path = url.slice(baseUrl.length).split('?')[0];

    if (path.startsWith('/project/')) {
      const rest = path.slice('/project/'.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        if (rest.slice(slash) !== '/version') {
          throw new TypeError(`unexpected fetch: ${url}`);
        }
        const projectId = decodeURIComponent(rest.slice(0, slash));
        const versions = data.versions[projectId];
        return versions ? jsonResponse(versions) : jsonResponse({ error: 'not_found' }, 404);
      }

      const reference = decodeURIComponent(rest);
      const project = projectsBySlug.get(reference) ?? projectsById.get(reference);
      return project ? jsonResponse(project) : jsonResponse({ error: 'not_found' }, 404);
    }

    if (path.startsWith('/version/')) {
      const versionId = decodeURIComponent(path.slice('/version/'.length));
      const version = versionsById.get(versionId);
      return version ? jsonResponse(version) : jsonResponse({ error: 'not_found' }, 404);
    }

    throw new TypeError(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  return { fn, calls };
};

const baseSpec = (): ClientPackSpec => ({
  gameVersion: '26.3',
  loader: { type: 'fabric', version: '0.20.1' },
  java: { major: 25 },
  mods: ['sodium'],
});

const resolveWith = async (
  data: ModrinthFixture,
  spec: ClientPackSpec,
  extra: Partial<ResolveClientPackOptions> = {}
): Promise<Awaited<ReturnType<typeof resolveClientPack>>> => {
  const { fn } = makeModrinthFetch(data);
  return resolveClientPack(spec, { fetchImpl: fn, now: fixedNow, ...extra });
};

const makeTempDir = (prefix = 'hydwind-publish-'): string =>
  mkdtempSync(join(tmpdir(), prefix));

const cleanupDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** 按本地文件头顺序读出条目名，用于验证「按路径排序」。 */
const localEntryNames = (zip: Buffer): string[] => {
  const names: string[] = [];
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    names.push(
      zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    );
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
};

// ------------------------------------------------------------ Modrinth 解析

test('release 选择：兼容的最新 release，过滤 beta/alpha/加载器/游戏版本', async () => {
  const data = loadFixture();
  const { fn, calls } = makeModrinthFetch(data);

  const resolved = await resolveClientPack(baseSpec(), { fetchImpl: fn, now: fixedNow });

  // sod-beta 与 sod-alpha 更新，但不是 release；sod-forge 加载器不符；
  // sod-old 游戏版本不符。
  const sodium = resolved.pack.mods.find((mod) => mod.projectId === 'AANobbMI');
  assert.ok(sodium);
  assert.equal(sodium.versionId, 'sod-200');
  assert.equal(sodium.filename, 'sodium-0.6.1.jar');
  assert.deepEqual(
    resolved.pack.mods.map((mod) => mod.projectId),
    ['AANobbMI', 'InDiUm01']
  );

  assert.equal(calls[0].headers['user-agent'], PACK_PUBLISHER_USER_AGENT);
  assert.equal(calls[0].headers.accept, 'application/json');
});

test('--modrinth-base 走镜像时，包里仍保存官方 CDN URL', async () => {
  const data = loadFixture();
  const mirrorBase = 'https://mod.mcimirror.top/v2';
  const { fn, calls } = makeModrinthFetch(data, mirrorBase);

  const resolved = await resolveClientPack(baseSpec(), {
    fetchImpl: fn,
    now: fixedNow,
    modrinthApiBase: mirrorBase,
  });

  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.url.startsWith(mirrorBase)));
  for (const mod of resolved.pack.mods) {
    assert.ok(mod.url.startsWith('https://cdn.modrinth.com/'));
  }
});

test('显式版本：直接使用（可为 beta），仍校验游戏版本与加载器', async () => {
  const data = loadFixture();

  const beta = await resolveWith(data, {
    ...baseSpec(),
    mods: [{ project: 'sodium', version: 'sod-beta' }],
  });
  assert.equal(beta.pack.mods[0].versionId, 'sod-beta');

  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'sod-forge' }],
    }),
    /不兼容加载器 fabric/
  );
  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'sod-old' }],
    }),
    /不支持游戏版本 26\.3/
  );
  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'nope-404' }],
    }),
    /HTTP 404/
  );
});

test('显式版本必须属于请求的项目', async () => {
  await assert.rejects(
    resolveWith(loadFixture(), {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'iris-200' }],
    }),
    /不属于项目/
  );
});

test('版本列表包含其他项目的版本时报错', async () => {
  const data = cloneFixture();
  versionIn(data, 'AANobbMI', 'sod-200').project_id = 'YL57xq9U';
  await assert.rejects(
    resolveWith(data, { ...baseSpec(), mods: ['sodium'] }),
    /其他项目的版本/
  );
});

test('Modrinth 429/5xx 仅在带 Retry-After 时有限重试', async () => {
  const modrinth = makeModrinthFetch(loadFixture());
  let attempts = 0;
  const retrying = (async (input: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    if (attempts === 1) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }
    return modrinth.fn(input, init);
  }) as typeof fetch;

  const resolved = await resolveClientPack(baseSpec(), {
    fetchImpl: retrying,
    now: fixedNow,
  });
  assert.ok(resolved.pack.mods.length > 0);
  assert.ok(attempts > modrinth.calls.length);

  let noRetryAttempts = 0;
  const noRetry = (async () => {
    noRetryAttempts += 1;
    return new Response('server error', { status: 503 });
  }) as typeof fetch;
  await assert.rejects(
    resolveClientPack(baseSpec(), { fetchImpl: noRetry, now: fixedNow }),
    /HTTP 503/
  );
  assert.equal(noRetryAttempts, 1);
});

test('加载器兼容：quilt 接受 fabric 版本，forge/neoforge 不互认', async () => {
  const data = loadFixture();
  const quilt = {
    ...baseSpec(),
    loader: { type: 'quilt' as const, version: '0.24.0' },
  };

  const fabricOnly = await resolveWith(data, {
    ...quilt,
    mods: [{ project: 'sodium', version: 'sod-fabriconly' }],
  });
  assert.equal(fabricOnly.pack.mods[0].versionId, 'sod-fabriconly');

  const auto = await resolveWith(data, quilt);
  assert.equal(
    auto.pack.mods.find((mod) => mod.projectId === 'AANobbMI')?.versionId,
    'sod-200'
  );

  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      loader: { type: 'neoforge', version: '26.3.0.115' },
      mods: [{ project: 'sodium', version: 'sod-forge' }],
    }),
    /不兼容加载器 neoforge/
  );
  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'sod-forge' }],
    }),
    /不兼容加载器 fabric/
  );
});

test('required 依赖递归展开；client_side unsupported 跳过；可选依赖忽略', async () => {
  const data = loadFixture();

  const resolved = await resolveWith(data, { ...baseSpec(), mods: ['iris'] });
  const ids = resolved.pack.mods.map((mod) => mod.projectId);

  assert.equal(ids.length, 4);
  assert.deepEqual(new Set(ids), new Set(['YL57xq9U', 'AANobbMI', 'gvQqBUqZ', 'InDiUm01']));
  assert.ok(!ids.includes('SrvOnly01'));
  assert.ok(!ids.includes('OcUlus01'));

  // 依赖显式 version_id 沿用；sodium 的间接依赖 indium 由 BFS 第二层加入。
  assert.equal(
    resolved.pack.mods.find((mod) => mod.projectId === 'gvQqBUqZ')?.versionId,
    'lit-100'
  );
  assert.equal(
    resolved.pack.mods.find((mod) => mod.projectId === 'InDiUm01')?.versionId,
    'ind-100'
  );
});

test('依赖的显式版本与游戏版本不匹配报错', async () => {
  const data = cloneFixture();
  const iris = versionIn(data, 'YL57xq9U', 'iris-200');
  const lithiumDependency = iris.dependencies.find(
    (dependency) => dependency.project_id === 'gvQqBUqZ'
  );
  assert.ok(lithiumDependency);
  lithiumDependency.version_id = 'lit-old';

  await assert.rejects(
    resolveWith(data, { ...baseSpec(), mods: ['iris'] }),
    /不支持游戏版本 26\.3/
  );
});

test('依赖只给 version_id 时反查所属项目并解析', async () => {
  const data = cloneFixture();
  const iris = versionIn(data, 'YL57xq9U', 'iris-200');
  const lithiumDependency = iris.dependencies.find(
    (dependency) => dependency.project_id === 'gvQqBUqZ'
  );
  assert.ok(lithiumDependency);
  delete lithiumDependency.project_id;

  const resolved = await resolveWith(data, { ...baseSpec(), mods: ['iris'] });
  assert.equal(
    resolved.pack.mods.find((mod) => mod.projectId === 'gvQqBUqZ')?.versionId,
    'lit-100'
  );
});

test('直接列出的项目 client_side unsupported 报错', async () => {
  await assert.rejects(
    resolveWith(loadFixture(), { ...baseSpec(), mods: ['serveronly'] }),
    /不支持客户端/
  );
});

test('去重：依赖同版本视为已满足，不同版本报错', async () => {
  const data = loadFixture();

  const satisfied = await resolveWith(data, {
    ...baseSpec(),
    mods: [{ project: 'lithium', version: 'lit-100' }, 'iris'],
  });
  assert.equal(
    satisfied.pack.mods.filter((mod) => mod.projectId === 'gvQqBUqZ').length,
    1
  );

  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: [{ project: 'lithium', version: 'lit-200' }, 'iris'],
    }),
    /依赖版本冲突/
  );

  // 依赖没有 version_id 时，项目已解析即视为满足。
  const autoSatisfied = await resolveWith(data, {
    ...baseSpec(),
    mods: [{ project: 'sodium', version: 'sod-100' }, 'iris'],
  });
  assert.equal(
    autoSatisfied.pack.mods.find((mod) => mod.projectId === 'AANobbMI')?.versionId,
    'sod-100'
  );
});

test('重复 project：spec 直接重复与 slug/id 别名都报错', async () => {
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), mods: ['sodium', 'sodium'] }),
    /项目重复/
  );

  await assert.rejects(
    resolveWith(loadFixture(), {
      ...baseSpec(),
      mods: ['sodium', { project: 'AANobbMI' }],
    }),
    /模组项目重复/
  );
});

test('循环依赖：同版本环被视为已满足，不悬挂', async () => {
  const resolved = await resolveWith(loadFixture(), {
    ...baseSpec(),
    mods: ['cyc-a'],
  });
  assert.deepEqual(
    resolved.pack.mods.map((mod) => mod.projectId).sort(),
    ['CycA0001', 'CycB0002']
  );
});

test('重复 filename 报错', async () => {
  const data = cloneFixture();
  versionIn(data, 'AANobbMI', 'sod-200').files[0].filename = 'lithium-0.5.0.jar';

  await assert.rejects(
    resolveWith(data, {
      ...baseSpec(),
      mods: ['sodium', { project: 'lithium', version: 'lit-100' }],
    }),
    /模组文件名重复/
  );
});

test('模组数量超过上限报错（注入小上限，避免构造 201 个项目）', async () => {
  await assert.rejects(
    resolveWith(
      loadFixture(),
      { ...baseSpec(), mods: ['sodium', 'lithium', 'iris'] },
      { maxMods: 2 }
    ),
    /数量超过上限 2/
  );
});

test('主文件选择：primary 优先，否则第一个', async () => {
  const withPrimary = cloneFixture();
  const version = versionIn(withPrimary, 'AANobbMI', 'sod-200');
  version.files = [
    {
      hashes: { sha512: '1'.repeat(128) },
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/sod-200/sodium-sources.jar',
      filename: 'sodium-sources.jar',
      primary: false,
      size: 10,
    },
    {
      hashes: { sha512: '2'.repeat(128) },
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/sod-200/sodium-primary.jar',
      filename: 'sodium-primary.jar',
      primary: true,
      size: 20,
    },
  ];
  const selected = await resolveWith(withPrimary, {
    ...baseSpec(),
    mods: [{ project: 'sodium', version: 'sod-200' }],
  });
  assert.equal(selected.pack.mods[0].filename, 'sodium-primary.jar');

  const withoutPrimary = cloneFixture();
  const firstVersion = versionIn(withoutPrimary, 'AANobbMI', 'sod-200');
  for (const file of firstVersion.files) file.primary = false;
  firstVersion.files = [
    {
      hashes: { sha512: '3'.repeat(128) },
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/sod-200/first.jar',
      filename: 'first.jar',
      primary: false,
      size: 10,
    },
    {
      hashes: { sha512: '4'.repeat(128) },
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/sod-200/second.jar',
      filename: 'second.jar',
      primary: false,
      size: 20,
    },
  ];
  const fallback = await resolveWith(withoutPrimary, {
    ...baseSpec(),
    mods: [{ project: 'sodium', version: 'sod-200' }],
  });
  assert.equal(fallback.pack.mods[0].filename, 'first.jar');
});

test('主文件缺 sha512/size/filename 或 URL 非法都报错', async () => {
  const cases: [string, (file: FixtureFile) => void, RegExp][] = [
    [
      '缺 sha512',
      (file) => {
        if (file.hashes) delete file.hashes.sha512;
      },
      /sha512/,
    ],
    ['缺 size', (file) => delete file.size, /size/],
    ['缺 filename', (file) => delete file.filename, /文件名/],
    ['非 CDN URL', (file) => (file.url = 'https://example.com/sodium.jar'), /cdn\.modrinth\.com/],
    [
      '非 HTTPS URL',
      (file) => (file.url = 'http://cdn.modrinth.com/data/x.jar'),
      /cdn\.modrinth\.com/,
    ],
    ['非法 filename', (file) => (file.filename = 'bad/name.jar'), /文件名/],
  ];

  for (const [label, mutate, expected] of cases) {
    const data = cloneFixture();
    mutate(versionIn(data, 'AANobbMI', 'sod-200').files[0]);
    await assert.rejects(
      resolveWith(data, {
        ...baseSpec(),
        mods: [{ project: 'sodium', version: 'sod-200' }],
      }),
      expected,
      label
    );
  }

  const empty = cloneFixture();
  versionIn(empty, 'AANobbMI', 'sod-200').files = [];
  await assert.rejects(
    resolveWith(empty, {
      ...baseSpec(),
      mods: [{ project: 'sodium', version: 'sod-200' }],
    }),
    /缺少文件/
  );
});

test('name 与 versionNumber 超长时截断到契约上限', async () => {
  const data = cloneFixture();
  data.projects.sodium.title = 'T'.repeat(150);
  versionIn(data, 'AANobbMI', 'sod-200').version_number = 'v'.repeat(80);

  const resolved = await resolveWith(data, {
    ...baseSpec(),
    mods: [{ project: 'sodium', version: 'sod-200' }],
  });
  const mod = resolved.pack.mods[0];
  assert.ok(mod);
  assert.equal(mod.name, 'T'.repeat(100));
  assert.equal(mod.versionNumber, 'v'.repeat(64));
});

// -------------------------------------------------------------- overrides

test('overrides：确定性 zip（排序、固定时间戳、UTF-8）、逐文件清单、可读回', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));

  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'm'), { recursive: true });
  writeFileSync(join(dir, 'config', 'b.toml'), 'b=2\n');
  writeFileSync(join(dir, 'config', 'a.toml'), 'a=1\n');
  writeFileSync(join(dir, 'config', 'empty.txt'), '');
  writeFileSync(join(dir, 'm', 'nested.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(dir, 'root.txt'), 'hello\n');

  const first = await buildOverridesPayload(dir);
  const second = await buildOverridesPayload(dir);
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.zip, second.zip);

  const entries = readZipEntries(first.zip);
  assert.deepEqual([...entries.keys()], [
    'config/a.toml',
    'config/b.toml',
    'config/empty.txt',
    'm/nested.bin',
    'root.txt',
  ]);
  assert.equal(entries.get('root.txt')?.toString(), 'hello\n');
  assert.deepEqual(entries.get('m/nested.bin'), Buffer.from([0, 1, 2, 3]));

  assert.deepEqual(
    first.manifest.files.map((file) => file.path),
    ['config/a.toml', 'config/b.toml', 'config/empty.txt', 'm/nested.bin', 'root.txt']
  );
  for (const file of first.manifest.files) {
    const content = entries.get(file.path);
    assert.ok(content);
    assert.equal(file.size, content.length);
    assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
  }
  assert.equal(first.manifest.sha256, createHash('sha256').update(first.zip).digest('hex'));
  assert.equal(first.manifest.size, first.zip.length);

  // 固定 DOS 时间戳 1980-01-01 00:00:00 与 UTF-8 标志。
  assert.equal(first.zip.readUInt32LE(0), 0x04034b50);
  assert.equal(first.zip.readUInt16LE(6), 0x0800);
  assert.equal(first.zip.readUInt16LE(10), 0);
  assert.equal(first.zip.readUInt16LE(12), 0x21);

  // 服务端读取端校验：zip 与逐文件清单完全一致。
  validateOverridesZip(first.zip, first.manifest);
});

test('overrides 拒绝符号链接', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  writeFileSync(join(dir, 'real.txt'), 'x');

  try {
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
  } catch {
    t.skip('当前平台不允许创建符号链接');
    return;
  }

  await assert.rejects(buildOverridesPayload(dir), /符号链接/);
});

test('overrides 拒绝反斜杠与控制字符文件名', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));

  try {
    writeFileSync(join(dir, 'bad\\name.txt'), 'x');
  } catch {
    t.skip('当前平台不允许反斜杠文件名');
    return;
  }
  await assert.rejects(buildOverridesPayload(dir), /路径不合法/);

  const controlDir = makeTempDir();
  t.after(() => cleanupDir(controlDir));
  try {
    writeFileSync(join(controlDir, `bad${String.fromCharCode(1)}name.txt`), 'x');
  } catch {
    t.skip('当前平台不允许控制字符文件名');
    return;
  }
  await assert.rejects(buildOverridesPayload(controlDir), /路径不合法/);
});

test('overrides 上限：文件数、解压总量、zip 大小', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  writeFileSync(join(dir, 'a.txt'), 'aa');
  writeFileSync(join(dir, 'b.txt'), 'bb');
  writeFileSync(join(dir, 'c.txt'), 'cc');

  await assert.rejects(buildOverridesPayload(dir, { maxFiles: 2 }), /文件数量超过上限 2/);
  await assert.rejects(buildOverridesPayload(dir, { maxBytes: 3 }), /总量超过上限/);
  await assert.rejects(buildOverridesPayload(dir, { maxZipBytes: 1 }), /zip 超过大小上限/);
});

test('overrides 按剩余额度在读取前拒绝超大文件', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(4));

  await assert.rejects(buildOverridesPayload(dir, { maxBytes: 3 }), /总量超过上限/);

  const exact = await buildOverridesPayload(dir, { maxBytes: 4 });
  assert.ok(exact);
  assert.equal(exact.manifest.files[0].size, 4);
});

test('overrides 拒绝首尾空白（含 NBSP）与 Windows 保留字符（POSIX）', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX 文件名测试');
    return;
  }
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));

  const spacedDir = join(dir, ' config');
  mkdirSync(spacedDir, { recursive: true });
  writeFileSync(join(spacedDir, 'a.toml'), 'x');
  await assert.rejects(buildOverridesPayload(dir), /路径不合法/, ' config/a.toml');
  rmSync(spacedDir, { recursive: true, force: true });

  const names = [
    ' lead.txt',
    'trail.txt ',
    `${String.fromCharCode(0xa0)}nbsp.txt`,
    'bad?name.txt',
  ];
  for (const name of names) {
    try {
      writeFileSync(join(dir, name), 'x');
    } catch {
      t.skip(`当前平台不允许文件名 ${JSON.stringify(name)}`);
      return;
    }
    await assert.rejects(buildOverridesPayload(dir), /路径不合法/, name);
    rmSync(join(dir, name), { force: true });
  }
});

test('overrides 根目录带尾斜杠时仍拒绝符号链接', async (t) => {
  const base = makeTempDir();
  t.after(() => cleanupDir(base));
  const real = join(base, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'a.txt'), 'x');
  const link = join(base, 'link');
  try {
    symlinkSync(real, link, 'dir');
  } catch {
    t.skip('当前平台不允许创建符号链接');
    return;
  }

  await assert.rejects(buildOverridesPayload(`${link}/`), /符号链接/);
});

test('无 overrides：空目录省略，目录不存在报错', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  assert.equal(await buildOverridesPayload(dir), null);

  await assert.rejects(buildOverridesPayload(join(dir, 'missing')), /不存在/);

  const resolved = await resolveWith(loadFixture(), baseSpec());
  assert.equal(resolved.pack.overrides, undefined);
  assert.equal(resolved.overridesZip, undefined);
});

test('resolve 集成：overrides 清单进包，pack.json 格式/固定时间/自校验', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'foo.toml'), 'enabled=true\n');

  const resolved = await resolveWith(loadFixture(), {
    ...baseSpec(),
    notes: '测试客户端包',
    minLauncherVersion: '0.5.0',
    overridesDir: dir,
  });

  assert.ok(resolved.pack.overrides);
  assert.ok(resolved.overridesZip);
  assert.ok(!('url' in resolved.pack.overrides));
  validateOverridesZip(resolved.overridesZip, resolved.pack.overrides);

  const text = serializeClientPackDraft(resolved.pack);
  assert.ok(text.endsWith('\n'));
  assert.ok(text.includes('\n  "schemaVersion": 1,'));
  assert.ok(text.includes('\n  "kind": "client-pack",'));

  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.createdAt, '2026-11-22T12:00:00Z');
  assert.equal('packVersion' in parsed, false);
  assert.equal(
    (parsed.overrides as Record<string, unknown>).url,
    undefined
  );

  assert.deepEqual(parseClientPackDraft(parsed), resolved.pack);
  assert.equal(defaultPackOutDir(resolved.pack.createdAt), 'dist/pack-2026-11-22T12-00-00Z');
});

// ------------------------------------------------------------------ spec

test('spec 形状校验：未知字段、非法值、重复项目', () => {
  const valid = fixture<ClientPackSpec>('publish-pack-spec.json');
  assert.deepEqual(parsePackSpec(valid).mods, [
    { project: 'sodium' },
    { project: 'iris' },
  ]);

  assert.throws(
    () => parsePackSpec({ ...baseSpec(), overrideDir: 'x' }),
    /未知字段/
  );
  assert.throws(() => parsePackSpec({ ...baseSpec(), gameVersion: '../26.3' }), /gameVersion/);
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), loader: { type: 'liteloader', version: '1' } }),
    /loader\.type/
  );
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), loader: { type: 'fabric', version: '../evil' } }),
    /loader\.version/
  );
  assert.throws(() => parsePackSpec({ ...baseSpec(), java: { major: 0 } }), /java\.major/);
  assert.throws(() => parsePackSpec({ ...baseSpec(), minLauncherVersion: '1.0' }), /minLauncherVersion/);
  assert.throws(() => parsePackSpec({ ...baseSpec(), mods: 'sodium' }), /mods/);
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), mods: [{ project: 'sodium', extra: true }] }),
    /未知字段/
  );
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), mods: [{ project: 'sodium', version: '../x' }] }),
    /version/
  );
  assert.throws(
    () =>
      parsePackSpec({
        ...baseSpec(),
        loader: { type: 'fabric', version: '0.20.1', extra: true },
      }),
    /loader 包含未知字段/
  );
  assert.throws(
    () => parsePackSpec({ ...baseSpec(), java: { major: 25, extra: true } }),
    /java 包含未知字段/
  );
});

// ---------------------------------------------------------------- publish

test('publish：FormData 字段、Authorization、packVersion；失败与网络错误抛错', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupDir(dir));
  writeFileSync(join(dir, 'a.txt'), 'x');

  const resolved = await resolveWith(loadFixture(), { ...baseSpec(), overridesDir: dir });
  assert.ok(resolved.overridesZip);

  const calls: { url: string; init: RequestInit }[] = [];
  const okFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return jsonResponse({ ...resolved.pack, packVersion: 7 });
  }) as typeof fetch;

  const result = await publishClientPack(resolved.pack, {
    token: 'secret',
    apiBase: 'http://api.test/',
    overridesZip: resolved.overridesZip,
    fetchImpl: okFetch,
  });
  assert.equal(result.packVersion, 7);

  assert.equal(calls[0].url, 'http://api.test/api/launcher/admin/client-pack');
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer secret' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('pack'), serializeClientPackDraft(resolved.pack));
  assert.deepEqual(parseClientPackDraft(JSON.parse(form.get('pack') as string)), resolved.pack);

  const overrides = form.get('overrides') as unknown as
    | { name?: string; size?: number }
    | null;
  assert.ok(overrides);
  assert.equal(overrides.name, 'overrides.zip');
  assert.equal(overrides.size, resolved.overridesZip.length);

  const noZipCalls: RequestInit[] = [];
  await publishClientPack(resolved.pack, {
    token: 'secret',
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      noZipCalls.push(init ?? {});
      return jsonResponse({ packVersion: 8 });
    }) as typeof fetch,
  });
  assert.equal((noZipCalls[0].body as FormData).has('overrides'), false);

  await assert.rejects(
    publishClientPack(resolved.pack, {
      token: 'secret',
      fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch,
    }),
    /HTTP 401/
  );

  await assert.rejects(
    publishClientPack(resolved.pack, {
      token: 'secret',
      fetchImpl: (async () => {
        throw new TypeError('boom');
      }) as typeof fetch,
    }),
    /发布请求失败/
  );

  await assert.rejects(
    publishClientPack(resolved.pack, {
      token: 'secret',
      fetchImpl: (async () => jsonResponse({ nope: true })) as typeof fetch,
    }),
    /packVersion/
  );
});

// -------------------------------------------------------------------- CLI

test('CLI：默认输出目录、--out、无 overrides、publish 成败与退出码', async (t) => {
  const root = makeTempDir('hydwind-cli-');
  t.after(() => cleanupDir(root));

  const overridesDir = join(root, 'overrides');
  mkdirSync(join(overridesDir, 'config'), { recursive: true });
  writeFileSync(join(overridesDir, 'config', 'client.toml'), 'fov=90\n');

  const specWithOverrides = {
    ...fixture<ClientPackSpec>('publish-pack-spec.json'),
    overridesDir,
  };
  const specPath = join(root, 'spec.json');
  writeFileSync(specPath, JSON.stringify(specWithOverrides));

  const specWithoutOverrides = fixture<ClientPackSpec>('publish-pack-spec.json');
  const specNoOverridesPath = join(root, 'spec-no-overrides.json');
  writeFileSync(specNoOverridesPath, JSON.stringify(specWithoutOverrides));

  const data = loadFixture();
  const modrinth = makeModrinthFetch(data);
  const adminCalls: { url: string; init: RequestInit }[] = [];
  let adminStatus = 200;

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/api/launcher/admin/client-pack')) {
      adminCalls.push({ url, init: init ?? {} });
      if (adminStatus !== 200) return new Response('admin down', { status: adminStatus });
      return jsonResponse({ packVersion: 12 });
    }
    return modrinth.fn(input, init);
  }) as typeof fetch;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const options: PublishPackCliOptions = {
    fetchImpl: fn,
    now: fixedNow,
    cwd: root,
    env: { LAUNCHER_ADMIN_TOKEN: 'token', CUSTOM_TOKEN: 'custom' },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };

  // 未 publish：默认目录 dist/pack-<createdAt>，写 pack.json 与 zip。
  assert.equal(await main([specPath], options), 0);
  const defaultOut = join(root, 'dist', 'pack-2026-11-22T12-00-00Z');
  assert.ok(existsSync(join(defaultOut, 'pack.json')));
  assert.ok(existsSync(join(defaultOut, 'overrides.zip')));

  const packText = readFileSync(join(defaultOut, 'pack.json'), 'utf8');
  assert.ok(packText.endsWith('\n'));
  const pack = JSON.parse(packText) as Record<string, unknown>;
  assert.equal(pack.createdAt, '2026-11-22T12:00:00Z');
  assert.ok(pack.overrides);

  // 显式 --out。
  const customOut = join(root, 'custom-out');
  assert.equal(await main([specPath, '--out', customOut], options), 0);
  assert.ok(existsSync(join(customOut, 'pack.json')));

  // 无 overrides：不写 zip。
  const noOverridesOut = join(root, 'no-overrides');
  assert.equal(await main([specNoOverridesPath, '--out', noOverridesOut], options), 0);
  assert.ok(existsSync(join(noOverridesOut, 'pack.json')));
  assert.equal(existsSync(join(noOverridesOut, 'overrides.zip')), false);

  // spec 里的 modrinthApiBase 会被采用（假 fetch 只认官方基址，因此失败）；
  // --modrinth-base 必须覆盖它。
  const specBadBase = {
    ...fixture<ClientPackSpec>('publish-pack-spec.json'),
    modrinthApiBase: 'https://bogus.invalid/v2',
  };
  const specBadBasePath = join(root, 'spec-bad-base.json');
  writeFileSync(specBadBasePath, JSON.stringify(specBadBase));
  assert.equal(await main([specBadBasePath], options), 1);
  assert.equal(
    await main(
      [
        specBadBasePath,
        '--out',
        join(root, 'mirror-base-out'),
        '--modrinth-base',
        MODRINTH_BASE,
      ],
      options
    ),
    0
  );
  assert.ok(existsSync(join(root, 'mirror-base-out', 'pack.json')));

  // publish 成功：自定义令牌环境变量。
  assert.equal(
    await main(
      [specPath, '--publish', '--api-base', 'http://api.test', '--token-env', 'CUSTOM_TOKEN'],
      options
    ),
    0
  );
  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].url, 'http://api.test/api/launcher/admin/client-pack');
  assert.equal(
    (adminCalls[0].init.headers as Record<string, string>).authorization,
    'Bearer custom'
  );
  assert.ok(stdout.some((line) => line.includes('packVersion: 12')));

  // 管理接口失败：退出码 1。
  adminStatus = 500;
  assert.equal(
    await main([specPath, '--publish', '--api-base', 'http://api.test'], options),
    1
  );
  assert.ok(stderr.some((line) => line.includes('发布客户端包失败')));

  // --help：只打印用法，退出码 0。
  assert.equal(await main(['--help'], options), 0);
  assert.ok(stdout.some((line) => line.includes('用法')));

  // spec 不是合法 JSON：退出码 1。
  const badJsonPath = join(root, 'spec-bad.json');
  writeFileSync(badJsonPath, '{');
  assert.equal(await main([badJsonPath], options), 1);
  assert.ok(stderr.some((line) => line.includes('读取 spec 失败')));

  // 带 UTF-8 BOM 的 spec 也能读取。
  const bomPath = join(root, 'spec-bom.json');
  writeFileSync(
    bomPath,
    `${String.fromCharCode(0xfeff)}${JSON.stringify(specWithoutOverrides)}`
  );
  const bomOut = join(root, 'bom-out');
  assert.equal(await main([bomPath, '--out', bomOut], options), 0);
  assert.ok(existsSync(join(bomOut, 'pack.json')));

  // 相对 --out 相对 cwd。
  assert.equal(await main([specNoOverridesPath, '--out', 'relative-out'], options), 0);
  assert.ok(existsSync(join(root, 'relative-out', 'pack.json')));

  // 同一输出目录复用时，无 overrides 的运行会删除上一轮的 zip。
  const reuseOut = join(root, 'reuse-out');
  assert.equal(await main([specPath, '--out', reuseOut], options), 0);
  assert.ok(existsSync(join(reuseOut, 'overrides.zip')));
  assert.equal(await main([specNoOverridesPath, '--out', reuseOut], options), 0);
  assert.equal(existsSync(join(reuseOut, 'overrides.zip')), false);

  // 输出目录不能落在 overrides 目录内。
  assert.equal(
    await main([specPath, '--out', join(overridesDir, 'nested-out')], options),
    1
  );
  assert.ok(stderr.some((line) => line.includes('overrides 目录')));

  // 缺令牌：退出码 1，且不请求管理接口或 Modrinth。
  const beforeMissingToken = adminCalls.length;
  const modrinthCallsBeforeMissingToken = modrinth.calls.length;
  assert.equal(
    await main([specPath, '--publish'], { ...options, env: {} }),
    1
  );
  assert.equal(adminCalls.length, beforeMissingToken);
  assert.equal(modrinth.calls.length, modrinthCallsBeforeMissingToken);
  assert.ok(stderr.some((line) => line.includes('LAUNCHER_ADMIN_TOKEN')));

  // 参数错误：退出码 2。
  assert.equal(await main(['--wat'], options), 2);
  assert.equal(await main([], options), 2);
});

// --------------------------------------------------------------- zip-write

test('zip-write：乱序输入排序一致、固定时间戳、UTF-8、store 可选、拒绝危险路径', () => {
  const entries = [
    { path: 'z.txt', data: Buffer.from('z') },
    { path: 'a.txt', data: Buffer.from('alpha') },
    { path: 'm/b.txt', data: Buffer.from('beta') },
    { path: 'm/配置.json', data: Buffer.from('{"x":1}') },
  ];

  const zip = writeZipEntries(entries);
  const alsoZip = writeZipEntries([...entries].reverse());
  assert.deepEqual(zip, alsoZip);

  assert.deepEqual(localEntryNames(zip), ['a.txt', 'm/b.txt', 'm/配置.json', 'z.txt']);

  const readBack = readZipEntries(zip);
  assert.equal(readBack.get('a.txt')?.toString(), 'alpha');
  assert.equal(readBack.get('m/配置.json')?.toString(), '{"x":1}');

  assert.equal(zip.readUInt16LE(6), 0x0800);
  assert.equal(zip.readUInt16LE(10), 0);
  assert.equal(zip.readUInt16LE(12), 0x21);

  // CRC32 已知常量："hello" = 0x3610a686。
  const crcZip = writeZipEntries([{ path: 'hello.txt', data: Buffer.from('hello') }]);
  assert.equal(crcZip.readUInt32LE(14), 0x3610a686);

  const stored = writeZipEntries([{ path: 'a.txt', data: Buffer.from('alpha') }], {
    method: 'store',
  });
  assert.equal(stored.readUInt16LE(8), 0);
  assert.equal(readZipEntries(stored).get('a.txt')?.toString(), 'alpha');

  assert.throws(
    () => writeZipEntries([{ path: '../evil', data: Buffer.from('x') }]),
    /路径不合法/
  );
  assert.throws(
    () =>
      writeZipEntries([
        { path: 'a.txt', data: Buffer.from('1') },
        { path: 'a.txt', data: Buffer.from('2') },
      ]),
    /路径重复/
  );

  for (const path of [
    'a<b.txt',
    'a>b.txt',
    'a"b.txt',
    'a|b.txt',
    'a?b.txt',
    'a*b.txt',
    'a:b.txt',
  ]) {
    assert.throws(
      () => writeZipEntries([{ path, data: Buffer.from('x') }]),
      /路径不合法/,
      path
    );
  }
});