import { createHash } from 'node:crypto';
import { BadRequestError, UpstreamError } from './errors.ts';
import type { LauncherDeps } from './http.ts';
import { fetchBytes } from './http.ts';
import type {
  ArchName,
  JsonRecord,
  LoaderRef,
  OsName,
  Platform,
} from './manifest.ts';
import { asNumber, asRecord, asString, isValidVersionId } from './manifest.ts';
import type { Mirror } from './mirror.ts';
import { rewriteUrlForMirror } from './mirror.ts';
import { fetchVersionJson } from './versions.ts';
import { readZipEntries, readZipJson, ZipError } from './zip.ts';

/**
 * Forge / NeoForge 安装器清单。
 *
 * 启动器拿到的仍是安装器 + 原始 `versionJson`/`installProfile`：处理器
 * 需要按 profile 自己执行，提前归一化会丢掉 data/processors。Java 版本
 * 从对应原版版本 JSON 读取。
 */
export interface InstallerManifest {
  schemaVersion: 1;
  kind: 'installer';
  id: string;
  gameVersion: string;
  loader: LoaderRef;
  os: OsName;
  arch: ArchName;
  java: { major: number; component?: string };
  installer: { url: string; sha1: string; size: number; path: string };
  versionJson: JsonRecord;
  installProfile: JsonRecord;
}

export interface InstallerRequest {
  gameVersion: string;
  loader: 'forge' | 'neoforge';
  loaderVersion: string;
  platform: Platform;
  mirror: Mirror;
}

export interface InstallerCoordinate {
  path: string;
  officialUrl: string;
  displayVersion: string;
}

const INSTALLER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES = 64 * 1024 * 1024;

const isSafeSegment = (value: string): boolean => /^[A-Za-z0-9._+\-]{1,64}$/.test(value);

export const installerCoordinate = (
  request: InstallerRequest
): InstallerCoordinate => {
  const { gameVersion, loader, loaderVersion } = request;
  if (!isValidVersionId(gameVersion)) throw new BadRequestError('非法 gameVersion');
  if (!isSafeSegment(loaderVersion)) throw new BadRequestError('非法 loaderVersion');

  if (loader === 'forge') {
    const full = loaderVersion.startsWith(`${gameVersion}-`)
      ? loaderVersion
      : `${gameVersion}-${loaderVersion}`;
    return {
      path: `net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
      officialUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
      displayVersion: full.slice(gameVersion.length + 1),
    };
  }

  if (gameVersion === '1.20.1') {
    const full = loaderVersion.startsWith(`${gameVersion}-`)
      ? loaderVersion
      : `${gameVersion}-${loaderVersion}`;
    return {
      path: `net/neoforged/forge/${full}/forge-${full}-installer.jar`,
      officialUrl: `https://maven.neoforged.net/releases/net/neoforged/forge/${full}/forge-${full}-installer.jar`,
      displayVersion: full.slice(gameVersion.length + 1),
    };
  }

  return {
    path: `net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
    officialUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
    displayVersion: loaderVersion,
  };
};

export interface ParsedInstaller {
  profile: JsonRecord;
  versionJson: JsonRecord;
}

/** 从安装器 ZIP 条目解出 install_profile.json 与 version.json。 */
export const parseInstallerEntries = (entries: Map<string, Buffer>): ParsedInstaller => {
  const profile = asRecord(readZipJson(entries, 'install_profile.json'));
  if (!profile) throw new ZipError('install_profile.json 不是对象');

  const jsonPath = asString(profile.json);
  if (jsonPath) {
    const versionJson = asRecord(readZipJson(entries, jsonPath));
    if (!versionJson) throw new ZipError('version.json 不是对象');
    return { profile, versionJson };
  }

  // Forge 1.8.9 / 1.12.2 的旧格式把版本 JSON 嵌在 install.versionInfo。
  const versionInfo = asRecord(profile.versionInfo);
  if (versionInfo) return { profile, versionJson: versionInfo };

  throw new ZipError('安装器缺少 version.json / install.versionInfo');
};

interface CachedInstaller {
  sha1: string;
  size: number;
  profile: JsonRecord;
  versionJson: JsonRecord;
}

const parseCachedInstaller = (text: string): CachedInstaller | null => {
  try {
    const root = asRecord(JSON.parse(text));
    const profile = asRecord(root?.profile);
    const versionJson = asRecord(root?.versionJson);
    const sha1 = asString(root?.sha1);
    const size = asNumber(root?.size);
    if (!profile || !versionJson || !sha1 || size === null) return null;
    return { profile, versionJson, sha1, size };
  } catch {
    return null;
  }
};

const javaFromVersion = (raw: JsonRecord): { major: number; component?: string } => {
  const javaVersion = asRecord(raw.javaVersion);
  const major = asNumber(javaVersion?.majorVersion) ?? 8;
  const component = asString(javaVersion?.component);
  return component ? { major, component } : { major };
};

const downloadInstaller = async (
  coordinate: InstallerCoordinate,
  request: InstallerRequest,
  deps: LauncherDeps
): Promise<{ bytes: Buffer; url: string }> => {
  const url = rewriteUrlForMirror(coordinate.officialUrl, request.mirror);

  try {
    const result = await fetchBytes(url, deps, {
      timeoutMs: 60_000,
      maxBytes: MAX_INSTALLER_BYTES,
    });
    return { bytes: result.bytes, url };
  } catch (error) {
    // 官方 NeoForge Maven 在部分网络不可达；镜像模式或官方失败时退回 BMCLAPI。
    if (!(error instanceof UpstreamError) || request.mirror === 'bmclapi') throw error;
    const fallbackUrl = rewriteUrlForMirror(coordinate.officialUrl, 'bmclapi');
    const result = await fetchBytes(fallbackUrl, deps, {
      timeoutMs: 60_000,
      maxBytes: MAX_INSTALLER_BYTES,
    });
    return { bytes: result.bytes, url: fallbackUrl };
  }
};

export const buildInstallerManifest = async (
  request: InstallerRequest,
  deps: LauncherDeps
): Promise<InstallerManifest> => {
  const coordinate = installerCoordinate(request);
  const cacheKey = `launcher:installer:${request.loader}:${request.gameVersion}:${coordinate.displayVersion}`;

  let installer = parseCachedInstaller(deps.cache.get(cacheKey, deps.now()) ?? '');
  let installerUrl = rewriteUrlForMirror(coordinate.officialUrl, request.mirror);

  if (!installer) {
    const downloaded = await downloadInstaller(coordinate, request, deps);
    installerUrl = downloaded.url;

    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(downloaded.bytes);
    } catch (error) {
      if (error instanceof ZipError) throw new UpstreamError(`安装器 ZIP 不合法: ${error.message}`);
      throw error;
    }

    let parsed: ParsedInstaller;
    try {
      parsed = parseInstallerEntries(entries);
    } catch (error) {
      if (error instanceof ZipError) throw new UpstreamError(`安装器格式不合法: ${error.message}`);
      throw error;
    }

    installer = {
      sha1: createHash('sha1').update(downloaded.bytes).digest('hex'),
      size: downloaded.bytes.byteLength,
      profile: parsed.profile,
      versionJson: parsed.versionJson,
    };
    deps.cache.set(cacheKey, JSON.stringify(installer), INSTALLER_TTL_MS, deps.now());
  }

  const profileMinecraft = asString(installer.profile.minecraft);
  if (profileMinecraft && profileMinecraft !== request.gameVersion) {
    throw new UpstreamError(
      `安装器目标版本 ${profileMinecraft} 与请求 ${request.gameVersion} 不一致`
    );
  }

  // java 以原版版本 JSON 为准；安装器 version.json 通常不含 javaVersion。
  const vanilla = await fetchVersionJson(request.gameVersion, deps, request.mirror);
  const java = javaFromVersion(installer.versionJson);
  const inheritedJava = asRecord(vanilla.raw.javaVersion);
  const javaMajor = asNumber(inheritedJava?.majorVersion);
  const javaComponent = asString(inheritedJava?.component);
  const resolvedJava =
    javaMajor === null
      ? java
      : javaComponent
        ? { major: javaMajor, component: javaComponent }
        : { major: javaMajor };

  const rawId = asString(installer.versionJson.id);
  const id =
    rawId && isValidVersionId(rawId)
      ? rawId
      : `${request.loader}-${request.gameVersion}-${coordinate.displayVersion}`;

  return {
    schemaVersion: 1,
    kind: 'installer',
    id,
    gameVersion: request.gameVersion,
    loader: { type: request.loader, version: coordinate.displayVersion },
    os: request.platform.os,
    arch: request.platform.arch,
    java: resolvedJava,
    installer: {
      url: installerUrl,
      sha1: installer.sha1,
      size: installer.size,
      path: coordinate.path,
    },
    versionJson: installer.versionJson,
    installProfile: installer.profile,
  };
};
