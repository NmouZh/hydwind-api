import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Hono } from 'hono';
import { memoryCacheStore } from '../src/launcher/cache.ts';
import type { JsonRecord } from '../src/launcher/manifest.ts';
import {
  evaluateRules,
  mergeVersionJson,
  normalizeVersionJson,
  parseMavenCoordinate,
  splitLegacyArguments,
} from '../src/launcher/manifest.ts';
import { createLauncherRoutes } from '../src/routes/launcher.ts';
import { VERSION_MANIFEST_URL } from '../src/launcher/versions.ts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/launcher/${name}`, import.meta.url), 'utf8')) as T;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type FakeFetch = typeof fetch;

const makeFetch = (routes: Record<string, () => Response>): { fn: FakeFetch; calls: string[] } => {
  const calls: string[] = [];
  const fn: FakeFetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) throw new TypeError(`unexpected fetch: ${url}`);
    return route();
  };
  return { fn, calls };
};

const makeApp = (fetchImpl: FakeFetch, clock = { now: Date.now() }): Hono => {
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

const linux = { os: 'linux' as const, arch: 'x86_64' as const };

// ------------------------------------------------------------- rules / args

test('rules：os/arch/features 与最后一条命中规则生效', () => {
  const base = { ...linux, features: {} };

  assert.equal(evaluateRules(undefined, base), true);
  assert.equal(evaluateRules([], base), true);
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'osx' } }], base), false);
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'linux' } }], base), true);
  assert.equal(evaluateRules([{ action: 'allow', os: { arch: 'arm64' } }], base), false);
  assert.equal(
    evaluateRules([{ action: 'allow', os: { arch: 'x86_64' } }], base),
    true
  );
  assert.equal(
    evaluateRules([{ action: 'allow', features: { has_custom_resolution: true } }], base),
    false
  );
  assert.equal(
    evaluateRules(
      [{ action: 'allow', features: { has_custom_resolution: true } }],
      { ...base, features: { has_custom_resolution: true } }
    ),
    true
  );
  assert.equal(
    evaluateRules([{ action: 'allow' }, { action: 'disallow', os: { name: 'linux' } }], base),
    false
  );
  assert.equal(
    evaluateRules([{ action: 'disallow', os: { name: 'linux' } }, { action: 'allow' }], base),
    true
  );
});

test('legacy minecraftArguments 按空格与引号切分', () => {
  assert.deepEqual(splitLegacyArguments('--a 1 --b "two words" --c'), [
    '--a',
    '1',
    '--b',
    'two words',
    '--c',
  ]);
});

test('Maven 坐标生成安全路径，非法坐标返回 null', () => {
  assert.equal(
    parseMavenCoordinate('net.minecraftforge:forge:26.3-66.1.9:universal')?.path,
    'net/minecraftforge/forge/26.3-66.1.9/forge-26.3-66.1.9-universal.jar'
  );
  assert.equal(parseMavenCoordinate('org.ow2.asm:asm@zip')?.path, 'org/ow2/asm/asm/asm.jar');
  assert.equal(parseMavenCoordinate('../../evil:artifact:1'), null);
  assert.equal(parseMavenCoordinate('group:artifact:1:classifier:extra'), null);
});

// ------------------------------------------------------------ vanilla 26.3

test('26.3 linux：过滤 os/arch/features 规则并保留参数', () => {
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const manifest = normalizeVersionJson(vanilla, {
    platform: linux,
    mirror: 'official',
    id: '26.3',
    gameVersion: '26.3',
    loader: null,
    versionJsonFile: {
      url: 'https://piston-meta.mojang.com/v1/packages/aaaa/26.3.json',
      sha1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      size: 1234,
    },
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'manifest');
  assert.equal(manifest.id, '26.3');
  assert.equal(manifest.gameVersion, '26.3');
  assert.equal(manifest.loader, null);
  assert.equal(manifest.os, 'linux');
  assert.equal(manifest.arch, 'x86_64');
  assert.deepEqual(manifest.java, { major: 25, component: 'java-runtime-epsilon' });
  assert.equal(manifest.mainClass, 'net.minecraft.client.main.Main');
  assert.equal(manifest.assetBaseUrl, 'https://resources.download.minecraft.net');

  assert.deepEqual(
    manifest.classpath,
    ['com/example/common/1.0/common-1.0.jar']
  );
  assert.deepEqual(
    manifest.files.map((file) => file.kind),
    ['client', 'library', 'asset-index', 'version-json']
  );

  const client = manifest.files[0];
  assert.equal(client.path, 'versions/26.3/26.3.jar');
  assert.equal(
    client.url,
    'https://piston-data.mojang.com/v1/objects/e877b6a07acd633fb3bb475002175cec036e7b87/client.jar'
  );
  assert.equal(manifest.assetIndex.id, '34');
  assert.equal(manifest.assetIndex.path, 'assets/indexes/34.json');
  assert.equal(manifest.assetIndex.size, 597235);
  assert.deepEqual(manifest.natives, []);

  assert.ok(manifest.arguments.game.includes('--username'));
  assert.ok(!manifest.arguments.game.includes('--mac'));
  assert.ok(!manifest.arguments.game.includes('--demo'));
  assert.ok(manifest.arguments.jvm.includes('-Djava.library.path=${natives_directory}'));
  assert.ok(!manifest.arguments.jvm.includes('-Dos.name=Windows'));
  assert.deepEqual(manifest.arguments.defaultUserJvm, [
    '-Xms2G',
    '-Xmx4G',
    '-XX:+UseCompactObjectHeaders',
  ]);
});

test('26.3 osx / windows-x86 / linux-arm64 的规则分支', () => {
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const normalize = (platform: { os: 'linux' | 'osx' | 'windows'; arch: 'x86' | 'x86_64' | 'arm64' }) =>
    normalizeVersionJson(vanilla, {
      platform,
      mirror: 'official',
      id: '26.3',
      gameVersion: '26.3',
      loader: null,
    });

  const osx = normalize({ os: 'osx', arch: 'x86_64' });
  assert.ok(osx.classpath.includes('com/example/mac-only/1.0/mac-only-1.0.jar'));
  assert.ok(osx.classpath.includes('com/example/not-linux/1.0/not-linux-1.0.jar'));
  assert.ok(osx.arguments.game.includes('--mac'));
  assert.ok(osx.arguments.defaultUserJvm.includes('-XX:+UseZGC'));

  const win32 = normalize({ os: 'windows', arch: 'x86' });
  assert.ok(win32.classpath.includes('com/example/win32/1.0/win32-1.0.jar'));
  assert.ok(!win32.classpath.includes('com/example/arm64/1.0/arm64-1.0.jar'));
  assert.ok(win32.arguments.jvm.includes('-Dos.name=Windows'));

  const win64 = normalize({ os: 'windows', arch: 'x86_64' });
  assert.ok(!win64.classpath.includes('com/example/win32/1.0/win32-1.0.jar'));

  const arm = normalize({ os: 'linux', arch: 'arm64' });
  assert.ok(arm.classpath.includes('com/example/arm64/1.0/arm64-1.0.jar'));
  assert.ok(!arm.classpath.includes('com/example/win32/1.0/win32-1.0.jar'));
});

test('mirror=bmclapi 重写 Mojang 与 Maven URL', () => {
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const manifest = normalizeVersionJson(vanilla, {
    platform: linux,
    mirror: 'bmclapi',
    id: '26.3',
    gameVersion: '26.3',
    loader: null,
    versionJsonFile: {
      url: 'https://piston-meta.mojang.com/v1/packages/aaaa/26.3.json',
      sha1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      size: 1234,
    },
  });

  assert.equal(
    manifest.files[0].url,
    'https://bmclapi2.bangbang93.com/v1/objects/e877b6a07acd633fb3bb475002175cec036e7b87/client.jar'
  );
  assert.equal(
    manifest.classpath.length,
    1
  );
  assert.equal(
    manifest.files.find((file) => file.kind === 'library')?.url,
    'https://bmclapi2.bangbang93.com/maven/com/example/common/1.0/common-1.0.jar'
  );
  assert.equal(
    manifest.assetIndex.url,
    'https://bmclapi2.bangbang93.com/v1/packages/f3df28b441565ca4e5deb9cda856d90df62e1433/34.json'
  );
  assert.equal(manifest.assetBaseUrl, 'https://bmclapi2.bangbang93.com/assets');
  assert.equal(
    manifest.files.find((file) => file.kind === 'version-json')?.url,
    'https://bmclapi2.bangbang93.com/v1/packages/aaaa/26.3.json'
  );
});

// ------------------------------------------------------------ vanilla 1.8.9

test('1.8.9 legacy minecraftArguments 与 natives 解压', () => {
  const legacy = fixture<JsonRecord>('vanilla-1.8.9.json');
  const manifest = normalizeVersionJson(legacy, {
    platform: linux,
    mirror: 'official',
    id: '1.8.9',
    gameVersion: '1.8.9',
    loader: null,
  });

  assert.equal(manifest.arguments.game.length, 14);
  assert.equal(manifest.arguments.game[0], '--username');
  assert.equal(manifest.arguments.game[13], '${auth_access_token}');
  assert.equal(manifest.natives.length, 1);
  assert.ok(manifest.natives[0].path.endsWith('natives-linux.jar'));
  assert.deepEqual(manifest.natives[0].extract, { exclude: ['META-INF/'] });
  assert.ok(
    manifest.files.some(
      (file) => file.kind === 'native-classpath' && file.path.endsWith('natives-linux.jar')
    )
  );
  assert.deepEqual(manifest.classpath, [
    'com/example/always/1.0/always-1.0.jar',
    'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209.jar',
  ]);

  const osx = normalizeVersionJson(legacy, {
    platform: { os: 'osx', arch: 'x86_64' },
    mirror: 'official',
    id: '1.8.9',
    gameVersion: '1.8.9',
    loader: null,
  });
  assert.deepEqual(osx.classpath, ['com/example/always/1.0/always-1.0.jar']);
  assert.equal(osx.natives.length, 0);
});

// ------------------------------------------------------------ fabric merge

test('Fabric profile 合并：loader 库在前、mainClass 用 loader、args 父前子后', () => {
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const profile = fixture<JsonRecord>('fabric-profile-26.3.json');
  const merged = mergeVersionJson(vanilla, profile);

  assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  const libraries = merged.libraries as JsonRecord[];
  assert.equal(libraries[0].name, 'org.ow2.asm:asm:9.10.1');

  const commons = libraries.filter(
    (library) => library.name === 'com.example:common:1.0' || library.name === 'com.example:common:1.1'
  );
  assert.deepEqual(commons.map((library) => library.name), ['com.example:common:1.1']);

  const args = merged.arguments as JsonRecord;
  const jvm = args.jvm as string[];
  assert.equal(jvm[0], '-Djava.library.path=${natives_directory}');
  assert.equal(jvm[jvm.length - 1], '-DFabricMcEmu= net.minecraft.client.main.Main ');
  const game = args.game as string[];
  assert.equal(game[0], '--username');
  assert.ok(game.some((item) => typeof item === 'object' && item !== null));

  const manifest = normalizeVersionJson(merged, {
    platform: linux,
    mirror: 'official',
    id: 'fabric-loader-0.20.1-26.3',
    gameVersion: '26.3',
    loader: { type: 'fabric', version: '0.20.1' },
  });
  assert.equal(manifest.loader?.type, 'fabric');
  assert.equal(manifest.java.major, 25);
  assert.equal(manifest.assetIndex.id, '34');
  assert.equal(manifest.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.equal(manifest.classpath[0], 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.equal(
    manifest.classpath[2],
    'com/example/common/1.1/common-1.1.jar'
  );
  assert.ok(!manifest.classpath.includes('com/example/common/1.0/common-1.0.jar'));
});

// ------------------------------------------------------- POST normalize

test('POST normalize：递归合并 inheritsFrom 并归一化', async () => {
  const versionManifest = fixture<JsonRecord>('version-manifest.json');
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const entries = versionManifest.versions as JsonRecord[];
  const vanillaUrl = String(entries.find((entry) => entry.id === '26.3')?.url);

  const { fn } = makeFetch({
    [VERSION_MANIFEST_URL]: () => jsonResponse(versionManifest),
    [vanillaUrl]: () => jsonResponse(vanilla),
  });

  const app = makeApp(fn);
  const body = {
    id: 'custom-forge',
    inheritsFrom: '26.3',
    mainClass: 'custom.Main',
    arguments: { game: ['--x'], jvm: ['-Dy'] },
    libraries: [
      {
        name: 'com.example:addon:1.0',
        downloads: {
          artifact: {
            path: 'com/example/addon/1.0/addon-1.0.jar',
            url: 'https://libraries.minecraft.net/com/example/addon/1.0/addon-1.0.jar',
            sha1: '3333333333333333333333333333333333333333',
            size: 10,
          },
        },
      },
    ],
  };

  const response = await app.request('/api/launcher/manifest/normalize?os=linux&arch=x86_64', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const manifest = (await response.json()) as JsonRecord;

  assert.equal(manifest.kind, 'manifest');
  assert.equal(manifest.id, 'custom-forge');
  assert.equal(manifest.gameVersion, '26.3');
  assert.equal(manifest.loader, null);
  assert.equal(manifest.mainClass, 'custom.Main');
  assert.deepEqual(manifest.java, { major: 25, component: 'java-runtime-epsilon' });

  const args = manifest.arguments as JsonRecord;
  assert.equal((args.game as string[])[0], '--username');
  assert.equal((args.game as string[]).at(-1), '--x');
  assert.equal((args.jvm as string[])[0], '-Djava.library.path=${natives_directory}');
  assert.equal((args.jvm as string[]).at(-1), '-Dy');

  const files = manifest.files as JsonRecord[];
  assert.ok(files.some((file) => file.path === 'com/example/addon/1.0/addon-1.0.jar'));
  assert.ok(!files.some((file) => file.kind === 'version-json'));
});

test('POST normalize：非法 id / 未知父版本 / 层级过深都返回 400', async () => {
  const versionManifest = fixture<JsonRecord>('version-manifest.json');
  const vanilla = fixture<JsonRecord>('vanilla-26.3.json');
  const entries = versionManifest.versions as JsonRecord[];
  const vanillaUrl = String(entries.find((entry) => entry.id === '26.3')?.url);

  const { fn } = makeFetch({
    [VERSION_MANIFEST_URL]: () => jsonResponse(versionManifest),
    [vanillaUrl]: () => jsonResponse(vanilla),
  });
  const app = makeApp(fn);

  const post = (body: unknown) =>
    app.request('/api/launcher/manifest/normalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const badId = await post({ id: '../evil' });
  assert.equal(badId.status, 400);
  assert.deepEqual(await badId.json(), {
    error: 'invalid_manifest',
    message: '版本 JSON 的 id 不合法',
  });

  const unknownParent = await post({ id: 'custom', inheritsFrom: 'not-a-real-version' });
  assert.equal(unknownParent.status, 400);

  const deepVersions: JsonRecord[] = [];
  const deepRoutes: Record<string, () => Response> = {
    [VERSION_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: 'v12', snapshot: 'v12' },
        versions: deepVersions,
      }),
  };
  for (let index = 0; index <= 12; index += 1) {
    const id = `v${index}`;
    const url = `https://piston-meta.mojang.com/v1/packages/${'0'.repeat(39)}${index}/${id}.json`;
    deepVersions.push({
      id,
      type: 'release',
      url,
      sha1: `${'0'.repeat(39)}${index}`,
      releaseTime: '2026-01-01T00:00:00+00:00',
    });
    deepRoutes[url] = () =>
      jsonResponse({
        id,
        inheritsFrom: index === 0 ? undefined : `v${index - 1}`,
        mainClass: 'deep.Main',
        arguments: { game: [], jvm: [] },
      });
  }

  const deepFetch = makeFetch(deepRoutes).fn;
  const deepApp = makeApp(deepFetch);
  const tooDeep = await deepApp.request('/api/launcher/manifest/normalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'v12', inheritsFrom: 'v11', mainClass: 'deep.Main' }),
  });
  assert.equal(tooDeep.status, 400);
  assert.equal(((await tooDeep.json()) as JsonRecord).error, 'invalid_manifest');
});

test('POST normalize：超过 2MiB 的请求体返回 413', async () => {
  const app = makeApp(makeFetch({}).fn);
  const body = `{"id":"x","padding":"${'a'.repeat(2 * 1024 * 1024)}"}`;

  const response = await app.request('/api/launcher/manifest/normalize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: '请求体太大' });
});
