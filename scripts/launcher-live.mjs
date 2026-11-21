#!/usr/bin/env node
/**
 * 启动器上游连通性检查（真实网络）。
 *
 * 直接调 service 层拉五份代表性 manifest：26.3 / 1.8.9 原版、Fabric
 * 0.20.1、Forge 66.1.9、NeoForge 26.3.0.115。打印 id / files 数 /
 * assetIndex 摘要，任何一步失败都以非零退出，供 upstream workflow 使用。
 *
 * 缓存用进程内 Map：这一跑要验证的就是「现在能从上游拿到」，命中本地
 * SQLite 缓存反而会让检查失去意义。
 */
import { buildInstallerManifest } from '../src/launcher/installer.ts';
import { buildNormalizedManifest } from '../src/launcher/service.ts';

const mirror = process.env.HYDWIND_MIRROR === 'bmclapi' ? 'bmclapi' : 'official';
const platform = { os: 'linux', arch: 'x86_64' };

const cacheEntries = new Map();
const deps = {
  fetchImpl: fetch,
  cache: {
    get(key, now) {
      const entry = cacheEntries.get(key);
      if (!entry || entry.expiresAt <= now) return null;
      return entry.body;
    },
    set(key, body, ttlMs, now) {
      cacheEntries.set(key, { body, expiresAt: now + ttlMs });
    },
    delete(key) {
      cacheEntries.delete(key);
    },
  },
  now: () => Date.now(),
  defaultMirror: mirror,
  modrinthUserAgent: 'hydwind-api-live/0.1.0 (+https://github.com/NmouZh/hydwind-api)',
};

const withRetry = async (label, attempt, retries = 2) => {
  for (let round = 0; ; round += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (round >= retries) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ${label} 第 ${round + 1} 次失败（${message}），重试…`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * (round + 1)));
    }
  }
};

const describeNormalized = (manifest) => {
  const assetIndex = manifest.assetIndex;
  const assetHost = assetIndex?.url ? new URL(assetIndex.url).host : '?';
  return {
    id: manifest.id,
    files: manifest.files.length,
    classpath: manifest.classpath.length,
    natives: manifest.natives.length,
    assetIndex: assetIndex ? `${assetIndex.id} (${assetHost}, ${assetIndex.size}B)` : '无',
    java: manifest.java?.major ?? '?',
  };
};

const describeInstaller = (manifest) => ({
  id: manifest.id,
  kind: manifest.kind,
  installerBytes: manifest.installer?.size ?? 0,
  installerHost: manifest.installer?.url ? new URL(manifest.installer.url).host : '?',
  versionJsonId: manifest.versionJson?.id ?? '?',
  java: manifest.java?.major ?? '?',
});

const cases = [
  {
    label: 'vanilla 26.3',
    run: () =>
      buildNormalizedManifest(
        { version: '26.3', loader: 'vanilla', platform, mirror },
        deps
      ),
    describe: describeNormalized,
  },
  {
    label: 'vanilla 1.8.9',
    run: () =>
      buildNormalizedManifest(
        { version: '1.8.9', loader: 'vanilla', platform, mirror },
        deps
      ),
    describe: describeNormalized,
  },
  {
    label: 'fabric 26.3 + 0.20.1',
    run: () =>
      buildNormalizedManifest(
        { version: '26.3', loader: 'fabric', loaderVersion: '0.20.1', platform, mirror },
        deps
      ),
    describe: describeNormalized,
  },
  {
    label: 'forge 26.3 + 66.1.9',
    run: () =>
      buildInstallerManifest(
        { gameVersion: '26.3', loader: 'forge', loaderVersion: '66.1.9', platform, mirror },
        deps
      ),
    describe: describeInstaller,
  },
  {
    label: 'neoforge 26.3 + 26.3.0.115',
    run: () =>
      buildInstallerManifest(
        { gameVersion: '26.3', loader: 'neoforge', loaderVersion: '26.3.0.115', platform, mirror },
        deps
      ),
    describe: describeInstaller,
  },
];

console.log(`launcher-live：mirror=${mirror}，共 ${cases.length} 个用例`);

const failures = [];
for (const testCase of cases) {
  try {
    const manifest = await withRetry(testCase.label, testCase.run);
    const summary = testCase.describe(manifest);
    console.log(`ok  ${testCase.label} → ${JSON.stringify(summary)}`);

    if (summary.files !== undefined && summary.files === 0) {
      throw new Error('files 为空');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${testCase.label}: ${message}`);
    console.error(`FAIL ${testCase.label}: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(`launcher-live 失败 ${failures.length}/${cases.length}：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`launcher-live 全部通过（${cases.length}/${cases.length}）`);