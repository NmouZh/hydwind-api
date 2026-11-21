import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { Hono } from 'hono';
import { memoryCacheStore } from '../src/launcher/cache.ts';
import { parseInstallerEntries } from '../src/launcher/installer.ts';
import {
  FABRIC_META,
  FORGE_MAVEN,
  FORGE_PROMOTIONS_URL,
  NEOFORGE_MAVEN,
  QUILT_META,
  fabricProfileUrl,
  forgeInstallerUrl,
  neoForgeInstallerUrl,
} from '../src/launcher/loaders.ts';
import { asRecord } from '../src/launcher/manifest.ts';
import { rewriteUrlForMirror } from '../src/launcher/mirror.ts';
import { MODRINTH_API, buildModrinthSearchUrl } from '../src/launcher/modrinth.ts';
import { VERSION_MANIFEST_URL } from '../src/launcher/versions.ts';
import { createLauncherRoutes, RATE_LIMIT } from '../src/routes/launcher.ts';

/**
 * 路由级测试：versions / loaders / manifest（vanilla、Fabric、Forge、
 * NeoForge）/ Modrinth / 缓存 / 上游错误 / 限流。
 *
 * fetch 全部注入，安装器 ZIP 在测试内用最小 ZIP 写入器现场构造，
 * 因此 CI 不访问网络。
 */

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/launcher/${name}`, import.meta.url), 'utf8');

const fixture = <T>(name: string): T => JSON.parse(fixtureText(name)) as T;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const textResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const bytesResponse = (bytes: Buffer): Response =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/java-archive' },
  });

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

type FetchImpl = typeof fetch;

const makeFetch = (
  routes: Record<string, () => Response>
): { fn: FetchImpl; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fn: FetchImpl = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const responder = routes[url];
    if (!responder) throw new TypeError(`unexpected fetch: ${url}`);
    return responder();
  };
  return { fn, calls };
};

const makeApp = (fetchImpl: FetchImpl, clock = { now: Date.now() }): Hono => {
  const app = new Hono();
  app.route(
    '/api/launcher',
    createLauncherRoutes({
      fetchImpl,
      cache: memoryCacheStore(),
      now: () => clock.now,
      defaultMirror: 'official',
      modrinthUserAgent: 'hydwind-test/1.0',
    })
  );
  return app;
};

/** 最小 ZIP 写入器：deflate 条目，供安装器解析测试使用。 */
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

const MANIFEST_URL = VERSION_MANIFEST_URL;

/** 从 version-manifest fixture 反查版本 JSON 的 URL，避免测试硬编码漂移。 */
const manifestFixture = fixture<{
  versions: { id: string; url: string }[];
}>('version-manifest.json');
const versionUrl = (id: string): string => {
  const entry = manifestFixture.versions.find((item) => item.id === id);
  if (!entry) throw new Error(`version-manifest fixture 缺少版本 ${id}`);
  return entry.url;
};
const VANILLA_263_URL = versionUrl('26.3');
const VANILLA_189_URL = versionUrl('1.8.9');

const loaderRoutes = (): Record<string, () => Response> => ({
  [`${FABRIC_META}/v2/versions/loader/26.3`]: () =>
    jsonResponse(fixture('fabric-loaders.json')),
  [`${QUILT_META}/v3/versions/loader/26.3`]: () =>
    jsonResponse(fixture('quilt-loaders.json')),
  [FORGE_PROMOTIONS_URL]: () => jsonResponse(fixture('forge-promotions.json')),
  [`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`]: () =>
    textResponse(fixtureText('forge-maven-metadata.xml')),
  [`${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`]: () =>
    textResponse(fixtureText('neoforge-maven-metadata.xml')),
});

// ---------------------------------------------------------------- versions

test('GET /versions：latest + 精简列表，第二次命中缓存', async () => {
  const { fn, calls } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
  });
  const app = makeApp(fn);

  const first = await app.request('/api/launcher/versions');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const body = (await first.json()) as {
    latest: { release: string; snapshot: string };
    versions: { id: string; type: string; releaseTime: string }[];
  };

  assert.deepEqual(body.latest, { release: '26.3', snapshot: '26.4-snapshot-10' });
  assert.deepEqual(body.versions.map((entry) => entry.id), [
    '26.4-snapshot-10',
    '26.3',
    '1.8.9',
  ]);
  assert.deepEqual(Object.keys(body.versions[0]).sort(), ['id', 'releaseTime', 'type']);
  assert.equal(body.versions[1].releaseTime, '2026-09-15T11:23:02+00:00');

  const second = await app.request('/api/launcher/versions');
  assert.equal(second.status, 200);
  assert.equal(calls.length, 1);
});

// ----------------------------------------------------------------- loaders

test('GET /loaders：四个 loader 只保留兼容版本，按新到旧排序', async () => {
  const { fn, calls } = makeFetch(loaderRoutes());
  const app = makeApp(fn);

  const response = await app.request('/api/launcher/loaders?gameVersion=26.3');
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    gameVersion: string;
    loaders: Record<string, { version: string; stable?: boolean; url?: string }[]>;
  };
  assert.equal(body.gameVersion, '26.3');

  assert.deepEqual(
    body.loaders.fabric.map((entry) => entry.version),
    ['0.20.1', '0.20.0', '0.19.5']
  );
  assert.equal(body.loaders.fabric[0].stable, true);
  assert.equal(body.loaders.fabric[1].stable, false);
  assert.equal(body.loaders.fabric[0].url, fabricProfileUrl('26.3', '0.20.1'));

  assert.deepEqual(
    body.loaders.quilt.map((entry) => entry.version),
    ['0.24.0', '0.20.0-beta.9', '0.20.0-beta.7']
  );
  assert.equal(body.loaders.quilt[0].stable, true);
  assert.equal(body.loaders.quilt[1].stable, false);

  assert.deepEqual(
    body.loaders.forge.map((entry) => entry.version),
    ['66.1.9', '66.1.8', '66.1.3']
  );
  assert.equal(body.loaders.forge[0].stable, true);
  assert.equal(body.loaders.forge[1].stable, undefined);
  assert.equal(body.loaders.forge[0].url, forgeInstallerUrl('26.3', '66.1.9'));

  assert.deepEqual(
    body.loaders.neoforge.map((entry) => entry.version),
    ['26.3.0.116-beta.1', '26.3.0.115', '26.3.0.114', '26.3.0.100']
  );
  assert.equal(body.loaders.neoforge[0].stable, undefined);
  assert.equal(body.loaders.neoforge[1].stable, true);

  const before = calls.length;
  assert.equal(before, 5);
  await app.request('/api/launcher/loaders?gameVersion=26.3');
  assert.equal(calls.length, before);
});

test('GET /loaders：未知游戏版本的 404 视为空列表', async () => {
  const routes = {
    ...loaderRoutes(),
    [`${FABRIC_META}/v2/versions/loader/0.0.0`]: () =>
      jsonResponse({ error: 'not_found' }, 404),
    [`${QUILT_META}/v3/versions/loader/0.0.0`]: () =>
      jsonResponse({ error: 'not_found' }, 404),
  };
  const { fn } = makeFetch(routes);
  const app = makeApp(fn);

  const response = await app.request('/api/launcher/loaders?gameVersion=0.0.0');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { loaders: Record<string, unknown[]> };
  for (const key of ['fabric', 'quilt', 'forge', 'neoforge']) {
    assert.deepEqual(body.loaders[key], []);
  }
});

test('GET /loaders：NeoForge 官方 Maven 不可达时回退 BMCLAPI', async () => {
  const bmclapiMetadataUrl = rewriteUrlForMirror(
    `${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`,
    'bmclapi'
  );
  const routes = {
    ...loaderRoutes(),
    [`${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`]: () => {
      throw new TypeError('fetch failed');
    },
    [bmclapiMetadataUrl]: () => textResponse(fixtureText('neoforge-maven-metadata.xml')),
  };
  const { fn, calls } = makeFetch(routes);
  const app = makeApp(fn);

  const response = await app.request('/api/launcher/loaders?gameVersion=26.3');
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    loaders: Record<string, { version: string }[]>;
  };
  assert.equal(body.loaders.neoforge[0]?.version, '26.3.0.116-beta.1');
  assert.ok(
    calls.some((call) => call.url.includes('bmclapi2.bangbang93.com/maven/net/neoforged'))
  );
});

test('GET /loaders：非法 gameVersion 返回 400', async () => {
  const app = makeApp(makeFetch({}).fn);
  const response = await app.request('/api/launcher/loaders?gameVersion=..%2Fevil');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'invalid_request',
    message: '非法 gameVersion',
  });
});

// ---------------------------------------------------------------- manifest

test('GET /manifest：vanilla 26.3 路由级归一化', async () => {
  const { fn } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
    [VANILLA_263_URL]: () => jsonResponse(fixture('vanilla-26.3.json')),
  });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/manifest?version=26.3&loader=vanilla&os=linux&arch=x86_64'
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    kind: string;
    loader: unknown;
    classpath: string[];
    files: { kind: string }[];
  };
  assert.equal(body.kind, 'manifest');
  assert.equal(body.loader, null);
  assert.deepEqual(body.classpath, ['com/example/common/1.0/common-1.0.jar']);
  assert.deepEqual(
    body.files.map((file) => file.kind),
    ['client', 'library', 'asset-index', 'version-json']
  );
});

test('GET /manifest：Fabric profile 与原版合并', async () => {
  const { fn } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
    [VANILLA_263_URL]: () => jsonResponse(fixture('vanilla-26.3.json')),
    [fabricProfileUrl('26.3', '0.20.1')]: () =>
      jsonResponse(fixture('fabric-profile-26.3.json')),
  });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/manifest?version=26.3&loader=fabric&loaderVersion=0.20.1'
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    id: string;
    loader: { type: string; version: string } | null;
    mainClass: string;
    classpath: string[];
    java: { major: number };
  };
  assert.equal(body.id, 'fabric-loader-0.20.1-26.3');
  assert.deepEqual(body.loader, { type: 'fabric', version: '0.20.1' });
  assert.equal(body.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.equal(body.classpath[0], 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.equal(body.java.major, 25);
});

test('GET /manifest mirror=bmclapi：1.8.9 的 client/asset/natives 全部重写', async () => {
  const { fn } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
    [rewriteUrlForMirror(VANILLA_189_URL, 'bmclapi')]: () =>
      jsonResponse(fixture('vanilla-1.8.9.json')),
  });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/manifest?version=1.8.9&loader=vanilla&os=windows&arch=x86_64&mirror=bmclapi'
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    files: { kind: string; url: string }[];
    natives: { url: string; path: string; extract?: { exclude?: string[] } }[];
    assetIndex: { url: string };
    assetBaseUrl: string;
  };

  assert.equal(
    body.files.find((file) => file.kind === 'client')?.url,
    'https://bmclapi2.bangbang93.com/v1/objects/3870888a6c3d349d3771a3e9d16c9bf5e076b908/client.jar'
  );
  assert.equal(
    body.assetIndex.url,
    'https://bmclapi2.bangbang93.com/v1/packages/f6ad102bcaa53b1a58358f16e376d548d44933ec/1.8.json'
  );
  assert.equal(body.assetBaseUrl, 'https://bmclapi2.bangbang93.com/assets');
  assert.equal(body.natives.length, 1);
  assert.ok(body.natives[0].path.endsWith('natives-windows.jar'));
  assert.ok(body.natives[0].url.startsWith('https://bmclapi2.bangbang93.com/maven/'));
  assert.deepEqual(body.natives[0].extract, { exclude: ['META-INF/'] });
});

test('GET /manifest：缺 loaderVersion / 非法参数返回 400，未知版本返回 404', async () => {
  const { fn } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
  });
  const app = makeApp(fn);

  const missingLoaderVersion = await app.request(
    '/api/launcher/manifest?version=26.3&loader=fabric'
  );
  assert.equal(missingLoaderVersion.status, 400);

  const badLoader = await app.request('/api/launcher/manifest?version=26.3&loader=liteloader');
  assert.equal(badLoader.status, 400);

  const badOs = await app.request('/api/launcher/manifest?version=26.3&os=plan9');
  assert.equal(badOs.status, 400);

  const badMirror = await app.request(
    '/api/launcher/manifest?version=26.3&mirror=cloudflare'
  );
  assert.equal(badMirror.status, 400);

  const missingVersion = await app.request('/api/launcher/manifest');
  assert.equal(missingVersion.status, 400);

  const unknown = await app.request('/api/launcher/manifest?version=9.9.9');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'not_found' });
});

// ---------------------------------------------------------------- installer

test('GET /manifest loader=forge：解包安装器返回 installer 清单', async () => {
  const installerZip = buildZip({
    'install_profile.json': fixtureText('forge-install-profile.json'),
    'version.json': fixtureText('forge-version.json'),
    'data/client.lzma': Buffer.from([1, 2, 3, 4]),
  });
  const installerUrl = forgeInstallerUrl('26.3', '66.1.9');
  const { fn, calls } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
    [VANILLA_263_URL]: () => jsonResponse(fixture('vanilla-26.3.json')),
    [installerUrl]: () => bytesResponse(installerZip),
  });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/manifest?version=26.3&loader=forge&loaderVersion=66.1.9&os=linux&arch=x86_64'
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    kind: string;
    id: string;
    gameVersion: string;
    loader: { type: string; version: string };
    java: { major: number; component?: string };
    installer: { url: string; sha1: string; size: number; path: string };
    versionJson: { mainClass: string; inheritsFrom: string; libraries: unknown[] };
    installProfile: { spec: number; profile: string; minecraft: string };
  };

  assert.equal(body.kind, 'installer');
  assert.equal(body.id, '26.3-forge-66.1.9');
  assert.equal(body.gameVersion, '26.3');
  assert.deepEqual(body.loader, { type: 'forge', version: '66.1.9' });
  assert.deepEqual(body.java, { major: 25, component: 'java-runtime-epsilon' });
  assert.equal(body.installer.url, installerUrl);
  assert.equal(
    body.installer.sha1,
    createHash('sha1').update(installerZip).digest('hex')
  );
  assert.equal(body.installer.size, installerZip.length);
  assert.equal(
    body.installer.path,
    new URL(installerUrl).pathname.slice(1)
  );
  assert.equal(body.versionJson.mainClass, 'net.minecraftforge.bootstrap.ForgeBootstrap');
  assert.equal(body.versionJson.inheritsFrom, '26.3');
  assert.equal(body.versionJson.libraries.length, 2);
  assert.equal(body.installProfile.spec, 1);
  assert.equal(body.installProfile.profile, 'forge');
  assert.equal(body.installProfile.minecraft, '26.3');

  const before = calls.length;
  await app.request(
    '/api/launcher/manifest?version=26.3&loader=forge&loaderVersion=66.1.9&os=linux&arch=x86_64'
  );
  assert.equal(calls.length, before);
});

test('GET /manifest loader=neoforge：官方安装器 5xx 时回退 BMCLAPI', async () => {
  const profile = {
    spec: 1,
    profile: 'NeoForge',
    version: 'neoforge-26.3.0.115',
    minecraft: '26.3',
    json: '/version.json',
  };
  const versionJson = {
    id: 'neoforge-26.3.0.115',
    inheritsFrom: '26.3',
    mainClass: 'net.neoforged.fml.startup.Client',
    arguments: { game: [], jvm: [] },
    libraries: [],
  };
  const installerZip = buildZip({
    'install_profile.json': JSON.stringify(profile),
    'version.json': JSON.stringify(versionJson),
  });

  const officialUrl = neoForgeInstallerUrl('26.3', '26.3.0.115');
  const bmclapiUrl = rewriteUrlForMirror(officialUrl, 'bmclapi');

  const { fn } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
    [VANILLA_263_URL]: () => jsonResponse(fixture('vanilla-26.3.json')),
    [officialUrl]: () => textResponse('upstream failed', 502),
    [bmclapiUrl]: () => bytesResponse(installerZip),
  });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/manifest?version=26.3&loader=neoforge&loaderVersion=26.3.0.115&os=linux&arch=x86_64'
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    kind: string;
    id: string;
    loader: { type: string; version: string };
    installer: { url: string };
  };
  assert.equal(body.kind, 'installer');
  assert.equal(body.id, 'neoforge-26.3.0.115');
  assert.deepEqual(body.loader, { type: 'neoforge', version: '26.3.0.115' });
  assert.equal(body.installer.url, bmclapiUrl);
});

test('旧版 Forge install_profile 的 versionInfo 能解出', () => {
  const parsed = parseInstallerEntries(
    new Map([
      [
        'install_profile.json',
        Buffer.from(fixtureText('forge-legacy-install-profile.json'), 'utf8'),
      ],
    ])
  );

  assert.equal(parsed.versionJson.id, '1.8.9-forge1.8.9-11.15.0.1661');
  assert.equal(parsed.versionJson.mainClass, 'net.minecraft.launchwrapper.Launch');
  assert.equal(asRecord(parsed.profile.install)?.minecraft, '1.8.9');
});

// ---------------------------------------------------------------- modrinth

const MODRINTH_PROJECT_URL = `${MODRINTH_API}/project/sodium`;
const MODRINTH_PROJECT_ID_URL = `${MODRINTH_API}/project/AANobbMI`;
const MODRINTH_VERSIONS_URL = `${MODRINTH_API}/project/AANobbMI/version`;
const MODRINTH_VERSION_URL = `${MODRINTH_API}/version/uEkz53eA`;
const MODRINTH_MODPACK_PROJECT_URL = `${MODRINTH_API}/project/1KVo5zza`;
const MODRINTH_MODPACK_SLUG_URL = `${MODRINTH_API}/project/fabulously-optimized`;

const modrinthRoutes = (): Record<string, () => Response> => ({
  [MODRINTH_PROJECT_URL]: () => jsonResponse(fixture('modrinth-project.json')),
  [MODRINTH_PROJECT_ID_URL]: () => jsonResponse(fixture('modrinth-project.json')),
  [MODRINTH_VERSIONS_URL]: () => jsonResponse(fixture('modrinth-versions.json')),
  [MODRINTH_VERSION_URL]: () => jsonResponse(fixture('modrinth-version.json')),
  [MODRINTH_MODPACK_PROJECT_URL]: () => jsonResponse(fixture('modrinth-modpack-project.json')),
  [MODRINTH_MODPACK_SLUG_URL]: () => jsonResponse(fixture('modrinth-modpack-project.json')),
});

test('GET /modrinth/search：facets 由服务端拼装，透传 Modrinth 响应', async () => {
  const parsed = buildModrinthSearchUrl({
    query: 'sodium',
    projectType: 'mod',
    gameVersion: '26.3',
    loader: 'fabric',
    limit: '5',
  });
  if ('error' in parsed) {
    assert.fail(`search URL 解析失败: ${parsed.error}`);
    return;
  }

  const { fn, calls } = makeFetch({ [parsed.url]: () => jsonResponse(fixture('modrinth-search.json')) });
  const app = makeApp(fn);

  const response = await app.request(
    '/api/launcher/modrinth/search?query=sodium&projectType=mod&gameVersion=26.3&loader=fabric&limit=5'
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { hits: { slug: string }[]; total_hits: number };
  assert.equal(body.hits[0].slug, 'sodium');
  assert.equal(body.total_hits, 1);

  const called = new URL(calls[0].url);
  assert.deepEqual(JSON.parse(called.searchParams.get('facets') ?? 'null'), [
    ['project_type:mod'],
    ['versions:26.3'],
    ['categories:fabric'],
  ]);
  assert.equal(called.searchParams.get('query'), 'sodium');
  assert.equal(called.searchParams.get('limit'), '5');
  assert.equal(called.searchParams.get('offset'), '0');
  assert.equal(calls[0].headers['user-agent'], 'hydwind-test/1.0');
});

test('GET /modrinth/search：非法 limit / 过长 query 返回 400', async () => {
  const app = makeApp(makeFetch({}).fn);

  const badLimit = await app.request('/api/launcher/modrinth/search?limit=0');
  assert.equal(badLimit.status, 400);

  const tooLong = await app.request(
    `/api/launcher/modrinth/search?query=${'a'.repeat(101)}`
  );
  assert.equal(tooLong.status, 400);
});

test('GET /modrinth/project：透传项目，404 映射为 not_found', async () => {
  const routes = {
    ...modrinthRoutes(),
    [`${MODRINTH_API}/project/unknown`]: () => jsonResponse({ error: 'not_found' }, 404),
  };
  const { fn } = makeFetch(routes);
  const app = makeApp(fn);

  const found = await app.request('/api/launcher/modrinth/project/sodium');
  assert.equal(found.status, 200);
  const project = (await found.json()) as { id: string; slug: string };
  assert.equal(project.id, 'AANobbMI');
  assert.equal(project.slug, 'sodium');

  // 同一项目用 id 请求也走通：modpack 校验依赖 project/AANobbMI 可达。
  const byId = await app.request('/api/launcher/modrinth/project/AANobbMI');
  assert.equal(byId.status, 200);
  assert.equal(((await byId.json()) as { slug: string }).slug, 'sodium');

  const missing = await app.request('/api/launcher/modrinth/project/unknown');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });
});

test('GET /modrinth/project/:id/versions：按 gameVersion 与 loader 过滤', async () => {
  const { fn } = makeFetch(modrinthRoutes());
  const app = makeApp(fn);

  const all = await app.request('/api/launcher/modrinth/project/AANobbMI/versions');
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as unknown[]).length, 3);

  const filtered = await app.request(
    '/api/launcher/modrinth/project/AANobbMI/versions?gameVersion=26.3&loader=fabric'
  );
  assert.equal(filtered.status, 200);
  const versions = (await filtered.json()) as { id: string; loaders: string[] }[];
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, 'FAbRiC0001');
  assert.deepEqual(versions[0].loaders, ['fabric']);
});

test('GET /modrinth/modpack：选主文件（.mrpack）并带依赖', async () => {
  const { fn } = makeFetch(modrinthRoutes());
  const app = makeApp(fn);

  const response = await app.request('/api/launcher/modrinth/modpack/1KVo5zza/uEkz53eA');
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    url: string;
    filename: string;
    size: number;
    dependencies: unknown[];
    projectId: string;
    versionId: string;
    hashes: Record<string, string>;
  };

  assert.ok(body.url.endsWith('Fabulously.Optimized-v15.0.0-beta.4.mrpack'));
  assert.equal(body.filename, 'Fabulously.Optimized-v15.0.0-beta.4.mrpack');
  assert.equal(body.size, 174274);
  assert.equal(body.dependencies.length, 2);
  assert.equal(body.projectId, '1KVo5zza');
  assert.equal(body.versionId, 'uEkz53eA');
  assert.equal(body.hashes.sha1, '90b3f76c0fce3c415120535d76eea3dbefa2f3a0');

  const bySlug = await app.request(
    '/api/launcher/modrinth/modpack/fabulously-optimized/uEkz53eA'
  );
  assert.equal(bySlug.status, 200);

  const wrongProject = await app.request(
    '/api/launcher/modrinth/modpack/AANobbMI/uEkz53eA'
  );
  assert.equal(wrongProject.status, 404);
});

test('Modrinth 缓存 5 分钟：命中期间不再请求上游', async () => {
  const clock = { now: Date.now() };
  const { fn, calls } = makeFetch(modrinthRoutes());
  const app = makeApp(fn, clock);

  await app.request('/api/launcher/modrinth/project/sodium');
  assert.equal(calls.length, 1);

  await app.request('/api/launcher/modrinth/project/sodium');
  assert.equal(calls.length, 1);

  clock.now += 5 * 60 * 1000 + 1;
  await app.request('/api/launcher/modrinth/project/sodium');
  assert.equal(calls.length, 2);
});

// ------------------------------------------------------------ 上游错误

test('上游 5xx → 502，超时 → 504，坏 JSON → 502', async () => {
  const failing = makeApp(
    makeFetch({ [MANIFEST_URL]: () => textResponse('boom', 500) }).fn
  );
  const upstreamFailure = await failing.request('/api/launcher/versions');
  assert.equal(upstreamFailure.status, 502);
  assert.deepEqual(await upstreamFailure.json(), { error: 'upstream_unavailable' });

  const timingOut = makeApp(
    makeFetch({
      [MANIFEST_URL]: () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      },
    }).fn
  );
  const timeout = await timingOut.request('/api/launcher/versions');
  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), { error: 'upstream_timeout' });

  const badJson = makeApp(
    makeFetch({ [MANIFEST_URL]: () => textResponse('not-json') }).fn
  );
  const malformed = await badJson.request('/api/launcher/versions');
  assert.equal(malformed.status, 502);
  assert.deepEqual(await malformed.json(), { error: 'upstream_unavailable' });
});

// ------------------------------------------------------------------ 限流

test('同一 IP 超过限额返回 429 并带 retry-after', async () => {
  const { fn, calls } = makeFetch({
    [MANIFEST_URL]: () => jsonResponse(fixture('version-manifest.json')),
  });
  const app = makeApp(fn);
  const headers = { 'x-forwarded-for': '198.51.100.77' };

  let sawLimit = false;
  for (let index = 0; index <= RATE_LIMIT; index += 1) {
    const response = await app.request('/api/launcher/versions', { headers });
    if (response.status === 429) {
      sawLimit = true;
      assert.equal(index, RATE_LIMIT);
      assert.ok(Number(response.headers.get('retry-after')) >= 1);
      assert.deepEqual(await response.json(), { error: 'rate_limited' });
      break;
    }
    assert.equal(response.status, 200);
  }

  assert.equal(sawLimit, true);
  // 限额测试期间全部命中缓存，只有第一次出站。
  assert.equal(calls.length, 1);
});
