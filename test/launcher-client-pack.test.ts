import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { Hono } from 'hono';
import { loadConfig } from '../src/config.ts';
import { memoryCacheStore } from '../src/launcher/cache.ts';
import {
  finalizeClientPack,
  isSafeFilename,
  isSafeRelativePath,
  matchesEtag,
  packEtag,
  parseClientPackDraft,
  parseStoredClientPack,
  sha256Hex,
  validateOverridesZip,
} from '../src/launcher/client-pack.ts';
import { createClientPackStore } from '../src/launcher/pack-store.ts';
import { readZipEntries } from '../src/launcher/zip.ts';
import { createLauncherRoutes } from '../src/routes/launcher.ts';
import type { LauncherRouteOptions } from '../src/routes/launcher.ts';

/**
 * 客户端包路由级测试。
 *
 * 全部走 Hono 内存请求与临时目录：不联网、不落 SQLite。覆盖公开读取 /
 * ETag、管理发布鉴权、schema 与 zip 校验、版本递增与保留、并发串行化、
 * overrides 下载与持久化。
 */

const ADMIN_TOKEN = 'launcher-admin-secret-test';
const ISSUE_TOKEN = 'issue-admin-secret-test';

const CLIENT_PATH = '/api/launcher/client';
const ADMIN_PATH = '/api/launcher/admin/client-pack';
const overridesPath = (packVersion: number | string): string =>
  `/api/launcher/client/overrides/${packVersion}`;

interface FixtureFile {
  path: string;
  content: string;
}

interface TestMod {
  projectId: string;
  versionId: string;
  name: string;
  versionNumber: string;
  filename: string;
  url: string;
  sha512: string;
  size: number;
}

interface TestOverrideFile {
  path: string;
  sha256: string;
  size: number;
}

interface TestOverrides {
  sha256: string;
  size: number;
  files: TestOverrideFile[];
  url?: string;
}

interface TestPack {
  schemaVersion: number;
  kind: string;
  createdAt: string;
  notes?: string;
  gameVersion: string;
  loader: { type: string; version: string };
  java: { major: number; component?: string };
  minLauncherVersion?: string;
  mods: TestMod[];
  overrides?: TestOverrides;
  packVersion?: number;
}

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/launcher/${name}`, import.meta.url), 'utf8')
  ) as T;

const baseDraft = (): TestPack => fixture<TestPack>('client-pack.json');

const overrideFixtureFiles = (): FixtureFile[] =>
  fixture<{ files: FixtureFile[] }>('client-pack-overrides-files.json').files;

const makeDir = (t: TestContext): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-client-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const makeApp = (
  dir: string,
  options: Partial<LauncherRouteOptions> = {}
): Hono => {
  const app = new Hono();
  app.route(
    '/api/launcher',
    createLauncherRoutes({
      fetchImpl: async () => {
        throw new TypeError('client-pack 测试不允许访问网络');
      },
      cache: memoryCacheStore(),
      now: () => Date.parse('2026-11-22T12:00:00Z'),
      defaultMirror: 'official',
      modrinthUserAgent: 'hydwind-test/1.0',
      clientPackDir: dir,
      launcherAdminToken: ADMIN_TOKEN,
      ...options,
    })
  );
  return app;
};

/** 改环境变量并在用例结束后恢复。 */
const useEnv = (t: TestContext, values: Record<string, string | undefined>): void => {
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

const jsonAs = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

/** 最小 ZIP 写入器：deflate 条目，与 launcher-api 测试保持同一实现。 */
const buildZip = (entries: Record<string, string | Buffer>): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const names = Object.keys(entries);
  let offset = 0;

  for (const name of names) {
    const data = Buffer.isBuffer(entries[name])
      ? entries[name]
      : Buffer.from(entries[name], 'utf8');
    const compressed = deflateRawSync(data);
    const nameBuffer = Buffer.from(name, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuffer, compressed);
    centralParts.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
};

interface RawZipEntry {
  name: string;
  data?: Buffer | string;
  /** 故意让本地头与中央目录不一致时使用。 */
  localName?: string;
  /** Unix mode 在外部属性高 16 位；DOS 目录位在低字节。 */
  externalAttrs?: number;
  store?: boolean;
}

const buildRawZip = (entries: RawZipEntry[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const payload = method === 0 ? data : deflateRawSync(data);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const localNameBuffer = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localNameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((entry.externalAttrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, localNameBuffer, payload);
    centralParts.push(central, nameBuffer);
    offset += 30 + localNameBuffer.length + payload.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
};

interface BuiltOverrides {
  zip: Buffer;
  overrides: TestOverrides;
}

const buildOverrides = (files: FixtureFile[]): BuiltOverrides => {
  const entries: Record<string, Buffer> = {};
  const manifest: TestOverrideFile[] = [];

  for (const file of files) {
    const content = Buffer.from(file.content, 'utf8');
    entries[file.path] = content;
    manifest.push({
      path: file.path,
      sha256: sha256Hex(content),
      size: content.length,
    });
  }

  const zip = buildZip(entries);
  return {
    zip,
    overrides: {
      sha256: sha256Hex(zip),
      size: zip.length,
      files: manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    },
  };
};

interface PublishOptions {
  overrides?: Buffer;
  /** undefined = 使用默认令牌，null = 不带 Authorization。 */
  token?: string | null;
}

const publishPack = async (
  app: Hono,
  pack: unknown,
  options: PublishOptions = {}
): Promise<Response> => {
  const form = new FormData();
  form.set('pack', JSON.stringify(pack));
  if (options.overrides !== undefined) {
    form.set(
      'overrides',
      new File([new Uint8Array(options.overrides)], 'overrides.zip', {
        type: 'application/zip',
      })
    );
  }

  const token = options.token === undefined ? ADMIN_TOKEN : options.token;
  const headers: Record<string, string> =
    token === null ? {} : { authorization: `Bearer ${token}` };

  return app.request(ADMIN_PATH, { method: 'PUT', headers, body: form });
};

// ------------------------------------------------------------- 公开读取

test('GET /client：未发布返回 404，overrides 同样 404', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);

  const client = await app.request(CLIENT_PATH);
  assert.equal(client.status, 404);
  assert.deepEqual(await client.json(), { error: 'not_found' });

  const overrides = await app.request(overridesPath(1));
  assert.equal(overrides.status, 404);
  assert.deepEqual(await overrides.json(), { error: 'not_found' });
});

test('发布成功：完整包、公开读取、ETag 与 If-None-Match', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);
  const draft = baseDraft();

  const published = await publishPack(app, draft);
  assert.equal(published.status, 200);
  const pack = await jsonAs<TestPack>(published);
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.kind, 'client-pack');
  assert.equal(pack.packVersion, 1);
  assert.equal(pack.createdAt, draft.createdAt);
  assert.equal(pack.notes, draft.notes);
  assert.equal(pack.gameVersion, draft.gameVersion);
  assert.deepEqual(pack.loader, draft.loader);
  assert.deepEqual(pack.java, draft.java);
  assert.equal(pack.minLauncherVersion, draft.minLauncherVersion);
  assert.deepEqual(pack.mods, draft.mods);
  assert.equal(pack.overrides, undefined);

  const rawBytes = readFileSync(path.join(dir, 'versions', '1', 'pack.json'));
  const etag = `"${createHash('sha256').update(rawBytes).digest('hex')}"`;

  const read = await app.request(CLIENT_PATH);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(read.headers.get('cache-control'), 'no-cache');
  assert.equal(read.headers.get('etag'), etag);
  const readBytes = Buffer.from(await read.arrayBuffer());
  assert.deepEqual(readBytes, rawBytes);
  assert.deepEqual(JSON.parse(readBytes.toString('utf8')), pack);

  for (const header of [
    etag,
    `"other", ${etag}`,
    `W/${etag}`,
    `  ${etag} , "other"`,
    '*',
  ]) {
    const notModified = await app.request(CLIENT_PATH, {
      headers: { 'if-none-match': header },
    });
    assert.equal(notModified.status, 304, header);
    assert.equal(notModified.headers.get('etag'), etag);
    assert.equal(notModified.headers.get('cache-control'), 'no-cache');
    assert.equal(await notModified.text(), '');
  }

  for (const header of ['"other"', 'W/"other"']) {
    const full = await app.request(CLIENT_PATH, {
      headers: { 'if-none-match': header },
    });
    assert.equal(full.status, 200, header);
    await full.arrayBuffer();
  }

  const republished = await publishPack(app, {
    ...baseDraft(),
    notes: '第二次发布',
  });
  assert.equal(republished.status, 200);
  assert.equal((await jsonAs<TestPack>(republished)).packVersion, 2);

  const readAgain = await app.request(CLIENT_PATH);
  assert.equal(readAgain.status, 200);
  assert.notEqual(readAgain.headers.get('etag'), etag);
  assert.equal((await jsonAs<TestPack>(readAgain)).packVersion, 2);
});

// --------------------------------------------------------------- 鉴权

test('管理接口鉴权：未配置、缺失、错误、ISSUE 令牌都 401 且不写盘', async (t) => {
  useEnv(t, { ISSUE_ADMIN_TOKEN: ISSUE_TOKEN, LAUNCHER_ADMIN_TOKEN: undefined });
  const dir = makeDir(t);

  const unconfigured = makeApp(dir, { launcherAdminToken: '' });
  for (const response of [
    await publishPack(unconfigured, baseDraft()),
    await publishPack(unconfigured, baseDraft(), { token: ADMIN_TOKEN }),
    await publishPack(unconfigured, baseDraft(), { token: ISSUE_TOKEN }),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }

  const configured = makeApp(dir);
  for (const response of [
    await publishPack(configured, baseDraft(), { token: null }),
    await publishPack(configured, baseDraft(), { token: 'wrong-token' }),
    await publishPack(configured, baseDraft(), { token: ISSUE_TOKEN }),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }

  assert.equal(existsSync(path.join(dir, 'current.json')), false);
  assert.equal(existsSync(path.join(dir, 'versions')), false);
});

test('管理接口不套读接口限流：超过 120 次未授权仍是 401', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);

  for (let index = 0; index < 125; index += 1) {
    const response = await app.request(ADMIN_PATH, { method: 'PUT', body: '' });
    assert.equal(response.status, 401);
  }
});

// ------------------------------------------------------------- 发布校验

test('发布校验失败返回 400 且 current 不变', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);

  const baseline = await publishPack(app, baseDraft());
  assert.equal(baseline.status, 200);
  const currentPath = path.join(dir, 'current.json');
  const currentBefore = readFileSync(currentPath, 'utf8');

  const files = overrideFixtureFiles();
  const firstFile = files[0]!;
  const built = buildOverrides(files);

  interface RejectCase {
    label: string;
    pack: TestPack;
    overrides?: Buffer;
    message?: RegExp;
  }
  const cases: RejectCase[] = [];

  const addMutated = (
    label: string,
    mutate: (pack: TestPack) => void,
    message?: RegExp
  ): void => {
    const pack = baseDraft();
    mutate(pack);
    cases.push({ label, pack, message });
  };

  const withOverrides = (): TestPack => ({
    ...baseDraft(),
    overrides: structuredClone(built.overrides),
  });

  addMutated('schemaVersion', (pack) => {
    pack.schemaVersion = 2;
  });
  addMutated('kind', (pack) => {
    pack.kind = 'server-pack';
  });
  addMutated('loader.type', (pack) => {
    pack.loader.type = 'vanilla';
  });
  addMutated('loader.version', (pack) => {
    pack.loader.version = '0.20/1';
  });
  addMutated('gameVersion', (pack) => {
    pack.gameVersion = '../26.3';
  });
  addMutated('mod URL', (pack) => {
    pack.mods[0]!.url = 'https://example.com/sodium.jar';
  });
  addMutated('mod sha512', (pack) => {
    pack.mods[0]!.sha512 = 'abcd';
  });
  addMutated('duplicate projectId', (pack) => {
    pack.mods[1]!.projectId = pack.mods[0]!.projectId;
  });
  addMutated('duplicate filename', (pack) => {
    pack.mods[1]!.filename = pack.mods[0]!.filename;
  });
  addMutated(
    'filename only differs by case: foo.jar vs FOO.jar',
    (pack) => {
      pack.mods[0]!.filename = 'foo.jar';
      pack.mods[1]!.filename = 'FOO.jar';
    },
    /模组文件名.*大小写.*FOO\.jar/
  );
  addMutated(
    'filename trailing dot',
    (pack) => {
      pack.mods[0]!.filename = 'foo.';
    },
    /mods\[0\]\.filename.*点或空格结尾/
  );
  addMutated(
    'filename trailing space',
    (pack) => {
      pack.mods[0]!.filename = 'foo ';
    },
    /mods\[0\]\.filename.*点或空格结尾/
  );
  addMutated(
    'filename contains colon',
    (pack) => {
      pack.mods[0]!.filename = 'a:b.jar';
    },
    /mods\[0\]\.filename.*冒号/
  );
  addMutated(
    'filename is Windows reserved device',
    (pack) => {
      pack.mods[0]!.filename = 'CON.jar';
    },
    /mods\[0\]\.filename.*保留设备名/
  );
  addMutated('more than 200 mods', (pack) => {
    pack.mods = Array.from({ length: 201 }, (_, index) => ({
      ...pack.mods[0]!,
      projectId: `P${index}`,
      versionId: `V${index}`,
      filename: `mod-${index}.jar`,
    }));
  });
  addMutated('minLauncherVersion', (pack) => {
    pack.minLauncherVersion = 'v0.5.0';
  });
  addMutated('java.major', (pack) => {
    pack.java.major = 25.5;
  });
  addMutated(
    'missing mods',
    (pack) => {
      delete (pack as Partial<TestPack>).mods;
    },
    /mods 必须是数组/
  );
  addMutated(
    'mods object instead of array',
    (pack) => {
      pack.mods = {} as TestMod[];
    },
    /mods 必须是数组/
  );
  addMutated(
    'minLauncherVersion trailing hyphen',
    (pack) => {
      pack.minLauncherVersion = '1.2.3-';
    },
    /minLauncherVersion 必须是严格 SemVer/
  );
  addMutated(
    'minLauncherVersion empty prerelease identifier',
    (pack) => {
      pack.minLauncherVersion = '1.2.3-..';
    },
    /minLauncherVersion 必须是严格 SemVer/
  );
  addMutated(
    'minLauncherVersion leading zero',
    (pack) => {
      pack.minLauncherVersion = '01.2.3';
    },
    /minLauncherVersion 必须是严格 SemVer/
  );

  for (const [label, badPath] of [
    ['overrides ../ path', '../evil.toml'],
    ['overrides absolute path', '/etc/passwd'],
    ['overrides backslash path', 'config\\foo.toml'],
    ['overrides control char path', 'config/\u0001foo.toml'],
  ] as const) {
    const pack = withOverrides();
    pack.overrides!.files[0]!.path = badPath;
    cases.push({ label, pack });
  }

  const addBadOverridePath = (label: string, badPath: string, message: RegExp): void => {
    const pack = withOverrides();
    pack.overrides!.files[0]!.path = badPath;
    cases.push({ label, pack, message });
  };
  addBadOverridePath(
    'overrides trailing dot segment',
    'config/foo./bar.toml',
    /overrides\.files\[0\]\.path.*点或空格结尾/
  );
  addBadOverridePath(
    'overrides trailing space segment',
    'config/foo /bar.toml',
    /overrides\.files\[0\]\.path.*点或空格结尾/
  );
  addBadOverridePath(
    'overrides trailing space at end',
    'config/foo.toml ',
    /overrides\.files\[0\]\.path.*点或空格结尾/
  );
  addBadOverridePath(
    'overrides colon path',
    'config/a:b.toml',
    /overrides\.files\[0\]\.path.*冒号/
  );
  addBadOverridePath(
    'overrides reserved device path',
    'CON/config.toml',
    /overrides\.files\[0\]\.path.*保留设备名/
  );

  const caseDuplicatePack = withOverrides();
  caseDuplicatePack.overrides!.files[1]!.path = 'config/FOO.TOML';
  cases.push({
    label: 'overrides path only differs by case: foo.toml vs FOO.TOML',
    pack: caseDuplicatePack,
    message: /overrides\.files\[1\]\.path.*大小写.*FOO\.TOML/,
  });

  cases.push({ label: 'no zip with overrides', pack: withOverrides() });
  cases.push({ label: 'zip without overrides manifest', pack: baseDraft(), overrides: built.zip });

  const extraZip = buildZip({
    'config/foo.toml': Buffer.from(firstFile.content, 'utf8'),
    'config/extra.toml': Buffer.from('extra\n', 'utf8'),
  });
  const singleBuilt = buildOverrides([firstFile]);
  const extraPack = baseDraft();
  extraPack.overrides = {
    sha256: sha256Hex(extraZip),
    size: extraZip.length,
    files: singleBuilt.overrides.files,
  };
  cases.push({ label: 'zip has extra entry', pack: extraPack, overrides: extraZip });

  const missingZip = buildZip({
    'config/foo.toml': Buffer.from(firstFile.content, 'utf8'),
    'config/bar.toml': Buffer.from('bar\n', 'utf8'),
  });
  const missingPack = baseDraft();
  missingPack.overrides = {
    sha256: sha256Hex(missingZip),
    size: missingZip.length,
    files: [
      singleBuilt.overrides.files[0]!,
      { path: 'config/missing.toml', sha256: '0'.repeat(64), size: 1 },
    ],
  };
  cases.push({ label: 'zip missing entry', pack: missingPack, overrides: missingZip });

  const sizePack = withOverrides();
  sizePack.overrides!.size = built.zip.length + 1;
  cases.push({ label: 'overrides size mismatch', pack: sizePack, overrides: built.zip });

  const shaPack = withOverrides();
  shaPack.overrides!.sha256 = '0'.repeat(64);
  cases.push({ label: 'overrides sha mismatch', pack: shaPack, overrides: built.zip });

  const fileSizePack = withOverrides();
  fileSizePack.overrides!.files[0]!.size += 1;
  cases.push({ label: 'file size mismatch', pack: fileSizePack, overrides: built.zip });

  const fileHashPack = withOverrides();
  fileHashPack.overrides!.files[0]!.sha256 = 'f'.repeat(64);
  cases.push({ label: 'file hash mismatch', pack: fileHashPack, overrides: built.zip });

  cases.push({
    label: 'packVersion in input',
    pack: { ...baseDraft(), packVersion: 1 },
    message: /packVersion/,
  });

  const urlPack = withOverrides();
  urlPack.overrides!.url = '/api/launcher/client/overrides/1';
  cases.push({
    label: 'overrides.url in input',
    pack: urlPack,
    overrides: built.zip,
    message: /overrides\.url/,
  });

  for (const item of cases) {
    const response = await publishPack(app, item.pack, {
      overrides: item.overrides,
    });
    assert.equal(response.status, 400, item.label);
    const body = (await response.json()) as { error: string; message?: string };
    assert.equal(body.error, 'invalid_request', item.label);
    if (item.message) assert.match(body.message ?? '', item.message, item.label);
    assert.equal(
      readFileSync(currentPath, 'utf8'),
      currentBefore,
      `${item.label}: current 被改动`
    );
  }

  const after = await app.request(CLIENT_PATH);
  assert.equal(after.status, 200);
  assert.equal((await jsonAs<TestPack>(after)).packVersion, 1);
});

test('Windows 边界内的文件名与路径可以发布', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);

  const built = buildOverrides(overrideFixtureFiles());
  const pack = baseDraft();
  pack.mods[0]!.filename = 'console.jar';
  pack.mods[1]!.filename = 'COM10.jar';
  pack.overrides = structuredClone(built.overrides);

  const response = await publishPack(app, pack, { overrides: built.zip });
  assert.equal(response.status, 200);
  const stored = await jsonAs<TestPack>(response);
  assert.equal(stored.mods[0]!.filename, 'console.jar');
  assert.equal(stored.mods[1]!.filename, 'COM10.jar');
  assert.deepEqual(
    stored.overrides!.files.map((file) => file.path),
    ['config/foo.toml', 'config/mod/config.json']
  );
});

test('请求体超过注入上限返回 413 且不发布', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir, { maxClientPackBodyBytes: 512 });

  const pack = baseDraft();
  pack.notes = 'x'.repeat(500);
  const response = await publishPack(app, pack);
  assert.equal(response.status, 413);
  assert.equal(existsSync(path.join(dir, 'current.json')), false);
});

test('超大请求体 + 错误令牌：鉴权先于 bodyLimit，返回 401', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir, { maxClientPackBodyBytes: 512 });

  const pack = baseDraft();
  pack.notes = 'x'.repeat(500);

  const wrong = await publishPack(app, pack, { token: 'wrong-token' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: 'unauthorized' });

  const missing = await publishPack(app, pack, { token: null });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'unauthorized' });

  assert.equal(existsSync(path.join(dir, 'current.json')), false);
});

// ----------------------------------------------------------- overrides

test('overrides 发布与下载：字节一致、immutable、非法版本 404', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);
  const built = buildOverrides(overrideFixtureFiles());
  const draft = baseDraft();
  draft.overrides = structuredClone(built.overrides);

  const published = await publishPack(app, draft, { overrides: built.zip });
  assert.equal(published.status, 200);
  const pack = await jsonAs<TestPack>(published);
  assert.equal(pack.overrides?.url, '/api/launcher/client/overrides/1');
  assert.equal(pack.overrides?.sha256, built.overrides.sha256);
  assert.equal(pack.overrides?.size, built.zip.length);
  assert.deepEqual(pack.overrides?.files, built.overrides.files);
  assert.deepEqual(
    readFileSync(path.join(dir, 'versions', '1', 'overrides.zip')),
    built.zip
  );

  const download = await app.request(pack.overrides!.url!);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.equal(
    download.headers.get('cache-control'),
    'public, max-age=31536000, immutable'
  );
  assert.equal(download.headers.get('content-length'), String(built.zip.length));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), built.zip);

  for (const value of ['abc', '0', '-1', '1.5', '999']) {
    const missing = await app.request(overridesPath(value));
    assert.equal(missing.status, 404, value);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  }

  const withoutOverrides = await publishPack(app, baseDraft());
  assert.equal(withoutOverrides.status, 200);
  assert.equal((await jsonAs<TestPack>(withoutOverrides)).packVersion, 2);
  const absent = await app.request(overridesPath(2));
  assert.equal(absent.status, 404);
});

// --------------------------------------------------- 递增、并发、持久化

test('packVersion 递增、并发发布串行化、保留最近 5 版', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);

  for (const notes of ['v1', 'v2']) {
    const response = await publishPack(app, { ...baseDraft(), notes });
    assert.equal(response.status, 200);
  }
  const readTwo = await app.request(CLIENT_PATH);
  assert.equal((await jsonAs<TestPack>(readTwo)).packVersion, 2);

  // 两个路由实例共享同一目录：模块级队列保证不会拿到同一个 packVersion。
  const other = makeApp(dir);
  const [left, right] = await Promise.all([
    publishPack(app, { ...baseDraft(), notes: '并发 A' }),
    publishPack(other, { ...baseDraft(), notes: '并发 B' }),
  ]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  const concurrentVersions = [
    (await jsonAs<TestPack>(left)).packVersion!,
    (await jsonAs<TestPack>(right)).packVersion!,
  ].sort((a, b) => a - b);
  assert.deepEqual(concurrentVersions, [3, 4]);

  for (const notes of ['v5', 'v6']) {
    const response = await publishPack(app, { ...baseDraft(), notes });
    assert.equal(response.status, 200);
  }

  const readSix = await app.request(CLIENT_PATH);
  assert.equal((await jsonAs<TestPack>(readSix)).packVersion, 6);

  const versionDirs = readdirSync(path.join(dir, 'versions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
  assert.deepEqual(versionDirs, [2, 3, 4, 5, 6]);
  assert.equal(existsSync(path.join(dir, 'versions', '1')), false);

  const pointer = JSON.parse(
    readFileSync(path.join(dir, 'current.json'), 'utf8')
  ) as { packVersion: number };
  assert.equal(pointer.packVersion, 6);
});

test('新路由实例读取同一目录（持久化）', async (t) => {
  const dir = makeDir(t);
  const built = buildOverrides(overrideFixtureFiles());
  const draft = baseDraft();
  draft.overrides = structuredClone(built.overrides);

  const first = makeApp(dir);
  const published = await publishPack(first, draft, { overrides: built.zip });
  assert.equal(published.status, 200);
  const publishedPack = await jsonAs<TestPack>(published);

  const second = makeApp(dir);
  const read = await second.request(CLIENT_PATH);
  assert.equal(read.status, 200);
  const pack = await jsonAs<TestPack>(read);
  assert.equal(pack.packVersion, 1);
  assert.deepEqual(pack, publishedPack);

  const download = await second.request(pack.overrides!.url!);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), built.zip);
});

test('current.json 内容损坏时发布会续号，文件系统错误仍然抛出', async (t) => {
  const dir = makeDir(t);
  const logs: string[] = [];
  const store = createClientPackStore({
    dir,
    logger: (message) => logs.push(message),
  });
  const draft = parseClientPackDraft(baseDraft());

  const first = await store.publish({ draft, overrides: null });
  assert.equal(first.packVersion, 1);

  const currentPath = path.join(dir, 'current.json');
  writeFileSync(currentPath, '{"packVersion":');
  const second = await store.publish({ draft, overrides: null });
  assert.equal(second.packVersion, 2);
  assert.match(logs.join('\n'), /current\.json 内容损坏/);

  writeFileSync(currentPath, '{"packVersion":0}');
  const third = await store.publish({ draft, overrides: null });
  assert.equal(third.packVersion, 3);

  // 文件系统错误不能被当成内容损坏吞掉。
  rmSync(currentPath, { force: true });
  mkdirSync(currentPath);
  await assert.rejects(store.publish({ draft, overrides: null }), /EISDIR/);
  assert.deepEqual(readdirSync(path.join(dir, 'versions')).sort(), ['1', '2', '3']);
});

// ------------------------------------------------------------- 纯函数

test('matchesEtag / 路径与文件名安全 / packEtag', () => {
  const etag = 'e3b0c44298fc1c149afbf4c8996fb924';
  assert.equal(matchesEtag(`"${etag}"`, etag), true);
  assert.equal(matchesEtag(`"other", "${etag}"`, etag), true);
  assert.equal(matchesEtag(`W/"${etag}"`, etag), true);
  assert.equal(matchesEtag(`  "${etag}" , "other"`, etag), true);
  assert.equal(matchesEtag('*', etag), true);
  assert.equal(matchesEtag('W/*', etag), true);
  assert.equal(matchesEtag(`"other", *`, etag), true);
  assert.equal(matchesEtag(`W/"other"`, etag), false);
  assert.equal(matchesEtag('"other"', etag), false);
  assert.equal(matchesEtag('', etag), false);

  assert.equal(isSafeRelativePath('config/foo.toml'), true);
  assert.equal(isSafeRelativePath('config/mod/config.json'), true);
  assert.equal(isSafeRelativePath('config/CONFIG.toml'), true);
  assert.equal(isSafeRelativePath('config/console.txt'), true);
  assert.equal(isSafeRelativePath('mods/com10/config.json'), true);
  assert.equal(isSafeRelativePath('../evil.toml'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('config\\foo.toml'), false);
  assert.equal(isSafeRelativePath('config/\u0001foo.toml'), false);
  assert.equal(isSafeRelativePath('C:/Windows/foo.toml'), false);
  assert.equal(isSafeRelativePath('config//foo.toml'), false);
  assert.equal(isSafeRelativePath('config/../foo.toml'), false);
  assert.equal(isSafeRelativePath('config/foo./bar.toml'), false);
  assert.equal(isSafeRelativePath('config/foo /bar.toml'), false);
  assert.equal(isSafeRelativePath('config/foo.toml.'), false);
  assert.equal(isSafeRelativePath('config/foo.toml '), false);
  assert.equal(isSafeRelativePath('config/a:b.toml'), false);
  assert.equal(isSafeRelativePath('CON/config.toml'), false);
  assert.equal(isSafeRelativePath('config/NUL.txt'), false);
  assert.equal(isSafeRelativePath('config/com1.jar'), false);
  assert.equal(isSafeRelativePath('config/LPT9'), false);

  assert.equal(isSafeFilename('sodium-0.6.0.jar'), true);
  assert.equal(isSafeFilename('console.jar'), true);
  assert.equal(isSafeFilename('COM10.jar'), true);
  assert.equal(isSafeFilename('con-sole.jar'), true);
  assert.equal(isSafeFilename('../evil.jar'), false);
  assert.equal(isSafeFilename('mods/sodium.jar'), false);
  assert.equal(isSafeFilename('bad\u0000.jar'), false);
  assert.equal(isSafeFilename('foo.'), false);
  assert.equal(isSafeFilename('foo '), false);
  assert.equal(isSafeFilename('a:b.jar'), false);
  assert.equal(isSafeFilename('CON'), false);
  assert.equal(isSafeFilename('con.txt'), false);
  assert.equal(isSafeFilename('COM1.jar'), false);
  assert.equal(isSafeFilename('LPT9'), false);

  assert.equal(packEtag('abc'), sha256Hex('abc'));
  assert.equal(packEtag('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.equal(packEtag(Buffer.from('abc')), packEtag('abc'));
});

test('zip 读取上限可覆盖：overrides 接受高压缩比与大条目，安装器默认仍拒绝', () => {
  // 高压缩比：1 MiB 重复文本，deflate 比率远超安装器默认的 200。
  const repetitive = Buffer.from('a'.repeat(1024 * 1024), 'utf8');
  const repetitiveZip = buildZip({ 'config/big.toml': repetitive });
  assert.throws(() => readZipEntries(repetitiveZip), /压缩比/);
  assert.doesNotThrow(() =>
    validateOverridesZip(repetitiveZip, {
      sha256: sha256Hex(repetitiveZip),
      size: repetitiveZip.length,
      files: [
        {
          path: 'config/big.toml',
          sha256: sha256Hex(repetitive),
          size: repetitive.length,
        },
      ],
    })
  );

  // 大条目：9 MiB 文本，超过安装器默认单条目 8 MiB。
  const large = Buffer.from(
    '0123456789abcdef'.repeat((9 * 1024 * 1024) / 16),
    'utf8'
  );
  const largeZip = buildZip({ 'config/large.txt': large });
  assert.throws(() => readZipEntries(largeZip), /条目过大/);
  assert.doesNotThrow(() =>
    validateOverridesZip(largeZip, {
      sha256: sha256Hex(largeZip),
      size: largeZip.length,
      files: [
        {
          path: 'config/large.txt',
          sha256: sha256Hex(large),
          size: large.length,
        },
      ],
    })
  );
});

test('overrides 严格 zip：拒绝规范化绕过、重复、目录、符号链接与本地头不一致', () => {
  const good = Buffer.from('enabled=true\n', 'utf8');
  const evil = Buffer.from('evil\n', 'utf8');

  const record = (filePath: string, data: Buffer): TestOverrideFile => ({
    path: filePath,
    sha256: sha256Hex(data),
    size: data.length,
  });
  const manifestFor = (zip: Buffer, files: TestOverrideFile[]): TestOverrides => ({
    sha256: sha256Hex(zip),
    size: zip.length,
    files,
  });

  const cases: Array<{
    label: string;
    zip: Buffer;
    files: TestOverrideFile[];
    message: RegExp;
  }> = [];

  const absolute = buildRawZip([{ name: '/config/foo.toml', data: good }]);
  cases.push({
    label: 'absolute name',
    zip: absolute,
    files: [record('config/foo.toml', good)],
    message: /绝对路径/,
  });

  const backslash = buildRawZip([{ name: 'config\\foo.toml', data: good }]);
  cases.push({
    label: 'backslash name',
    zip: backslash,
    files: [record('config/foo.toml', good)],
    message: /反斜杠/,
  });

  const traversal = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: '../evil', data: evil },
  ]);
  cases.push({
    label: 'valid file plus traversal entry',
    zip: traversal,
    files: [record('config/foo.toml', good)],
    message: /\.\./,
  });

  // EOCD 少报条目数，让第二个条目藏在中央目录里。
  const hiddenEntry = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: 'config/hidden.toml', data: evil },
  ]);
  hiddenEntry.writeUInt16LE(1, hiddenEntry.length - 14);
  hiddenEntry.writeUInt16LE(1, hiddenEntry.length - 12);
  cases.push({
    label: 'hidden central directory entry',
    zip: hiddenEntry,
    files: [record('config/foo.toml', good)],
    message: /条目数与目录大小不一致/,
  });

  const duplicate = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: 'config/foo.toml', data: evil },
  ]);
  cases.push({
    label: 'duplicate entry',
    zip: duplicate,
    files: [record('config/foo.toml', good)],
    message: /条目重复/,
  });

  const caseDuplicate = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: 'config/FOO.TOML', data: evil },
  ]);
  cases.push({
    label: 'case-insensitive duplicate',
    zip: caseDuplicate,
    files: [record('config/foo.toml', good), record('config/FOO.TOML', evil)],
    message: /大小写不同而重复/,
  });

  const symlink = buildRawZip([
    { name: 'config/link.toml', data: good, externalAttrs: 0o120777 << 16 },
  ]);
  cases.push({
    label: 'symlink entry',
    zip: symlink,
    files: [record('config/link.toml', good)],
    message: /符号链接/,
  });

  const specialFile = buildRawZip([
    { name: 'config/pipe.toml', data: good, externalAttrs: 0o010777 << 16 },
  ]);
  cases.push({
    label: 'special file type',
    zip: specialFile,
    files: [record('config/pipe.toml', good)],
    message: /不是普通文件/,
  });

  const reservedName = buildRawZip([{ name: 'CON/config.toml', data: good }]);
  cases.push({
    label: 'Windows reserved segment',
    zip: reservedName,
    files: [record('CON/config.toml', good)],
    message: /保留设备名/,
  });

  const colonName = buildRawZip([{ name: 'config/a:b.toml', data: good }]);
  cases.push({
    label: 'colon in segment',
    zip: colonName,
    files: [record('config/a:b.toml', good)],
    message: /冒号/,
  });

  const directory = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: 'config/', data: Buffer.alloc(0) },
  ]);
  cases.push({
    label: 'directory entry',
    zip: directory,
    files: [record('config/foo.toml', good)],
    message: /目录条目/,
  });

  const localMismatch = buildRawZip([
    { name: 'config/foo.toml', localName: 'config/evil.toml', data: good },
  ]);
  cases.push({
    label: 'local header name mismatch',
    zip: localMismatch,
    files: [record('config/foo.toml', good)],
    message: /本地文件头名称/,
  });

  const illegalChar = buildRawZip([{ name: 'config/bad?.toml', data: good }]);
  cases.push({
    label: 'Windows illegal character',
    zip: illegalChar,
    files: [record('config/bad?.toml', good)],
    message: /非法字符/,
  });

  const trailingDot = buildRawZip([{ name: 'config/foo./bar.toml', data: good }]);
  cases.push({
    label: 'trailing dot segment',
    zip: trailingDot,
    files: [record('config/foo./bar.toml', good)],
    message: /点或空格结尾/,
  });

  for (const item of cases) {
    assert.throws(
      () => validateOverridesZip(item.zip, manifestFor(item.zip, item.files)),
      item.message,
      item.label
    );
    assert.throws(
      () => readZipEntries(item.zip, { strict: true }),
      item.message,
      item.label
    );
  }

  // 严格模式仍接受发布器产生的普通 zip（含 UTF-8 文本条目）。
  const valid = buildZip({ 'config/foo.toml': good });
  assert.deepEqual(
    [...readZipEntries(valid, { strict: true }).keys()],
    ['config/foo.toml']
  );
});

test('发布拒绝可绕过的 overrides zip（合法文件 + ../evil）', async (t) => {
  const dir = makeDir(t);
  const app = makeApp(dir);
  const good = Buffer.from('enabled=true\n', 'utf8');
  const zip = buildRawZip([
    { name: 'config/foo.toml', data: good },
    { name: '../evil', data: Buffer.from('evil\n', 'utf8') },
  ]);

  const pack = baseDraft();
  pack.overrides = {
    sha256: sha256Hex(zip),
    size: zip.length,
    files: [{ path: 'config/foo.toml', sha256: sha256Hex(good), size: good.length }],
  };
  const response = await publishPack(app, pack, { overrides: zip });
  assert.equal(response.status, 400);
  assert.equal(existsSync(path.join(dir, 'current.json')), false);
});

test('zip 条目上限只计文件条目，不计目录', () => {
  const zip = buildRawZip([
    { name: 'config/foo.toml', data: 'x' },
    { name: 'config/', data: Buffer.alloc(0) },
  ]);
  const entries = readZipEntries(zip, { maxEntries: 1 });
  assert.deepEqual([...entries.keys()], ['config/foo.toml']);
});

test('校验模块：默认拒绝服务端字段，已存包解析接受并校验 overrides.url', () => {
  const draft = baseDraft();
  assert.throws(() => parseClientPackDraft({ ...draft, packVersion: 7 }), /packVersion/);

  const overrides = {
    sha256: '0'.repeat(64),
    size: 1,
    files: [{ path: 'config/foo.toml', sha256: '0'.repeat(64), size: 1 }],
  };
  assert.throws(
    () =>
      parseClientPackDraft({
        ...draft,
        overrides: { ...overrides, url: '/api/launcher/client/overrides/1' },
      }),
    /overrides\.url/
  );

  const withBuildMetadata = parseClientPackDraft({
    ...draft,
    minLauncherVersion: '1.0.0+5',
  });
  assert.equal(withBuildMetadata.minLauncherVersion, '1.0.0+5');
  const withPrerelease = parseClientPackDraft({
    ...draft,
    minLauncherVersion: '1.2.3-rc.1+build.5',
  });
  assert.equal(withPrerelease.minLauncherVersion, '1.2.3-rc.1+build.5');

  const ordered = parseClientPackDraft({
    ...draft,
    overrides: {
      sha256: '0'.repeat(64),
      size: 2,
      files: [
        { path: 'config/a.toml', sha256: '0'.repeat(64), size: 1 },
        { path: 'config/B.toml', sha256: '1'.repeat(64), size: 1 },
      ],
    },
  });
  assert.deepEqual(
    ordered.overrides!.files.map((file) => file.path),
    ['config/B.toml', 'config/a.toml']
  );

  const parsedDraft = parseClientPackDraft({ ...draft, overrides });
  const finalized = finalizeClientPack(parsedDraft, 7);
  assert.equal(finalized.packVersion, 7);
  assert.deepEqual(finalized.overrides, {
    url: '/api/launcher/client/overrides/7',
    sha256: overrides.sha256,
    size: overrides.size,
    files: overrides.files,
  });

  const stored = JSON.parse(JSON.stringify(finalized)) as TestPack;
  const parsed = parseStoredClientPack(stored);
  assert.equal(parsed.packVersion, 7);
  assert.equal(parsed.overrides?.url, '/api/launcher/client/overrides/7');

  // 未知字段（阶段 D 的 verification）在读取端被忽略。
  const withUnknown = parseStoredClientPack({
    ...JSON.parse(JSON.stringify(finalized)),
    verification: { future: true },
  });
  assert.equal(withUnknown.packVersion, 7);

  const wrongUrl = JSON.parse(JSON.stringify(finalized)) as TestPack;
  wrongUrl.overrides!.url = '/api/launcher/client/overrides/8';
  assert.throws(() => parseStoredClientPack(wrongUrl), /overrides\.url/);

  // 读取端同样执行 Windows 名称规则与大小写重复检查。
  const storedCaseDuplicate = JSON.parse(JSON.stringify(finalized)) as TestPack;
  storedCaseDuplicate.mods[1]!.filename = storedCaseDuplicate.mods[0]!.filename.toUpperCase();
  assert.throws(() => parseStoredClientPack(storedCaseDuplicate), /模组文件名.*大小写/);

  const storedReservedPath = JSON.parse(JSON.stringify(finalized)) as TestPack;
  storedReservedPath.overrides!.files[0]!.path = 'CON/config.toml';
  assert.throws(() => parseStoredClientPack(storedReservedPath), /保留设备名/);
});

test('loadConfig：LAUNCHER_ADMIN_TOKEN 独立配置，clientPackDir 默认在数据目录下', () => {
  const configured = loadConfig({
    HYDWIND_DATA_DIR: '/srv/hydwind',
    LAUNCHER_ADMIN_TOKEN: '  pack-secret  ',
  });
  assert.equal(configured.launcherAdminToken, 'pack-secret');
  assert.equal(configured.clientPackDir, path.resolve('/srv/hydwind/launcher/client-pack'));

  const unset = loadConfig({ HYDWIND_DATA_DIR: '/srv/hydwind' });
  assert.equal(unset.launcherAdminToken, '');
  assert.equal(unset.clientPackDir, path.resolve('/srv/hydwind/launcher/client-pack'));
});