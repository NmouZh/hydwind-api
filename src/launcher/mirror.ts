/** 镜像来源：官方直连或 BMCLAPI。 */
export type Mirror = 'official' | 'bmclapi';

/**
 * BMCLAPI 镜像重写。
 *
 * 2026-11 实测：bmclapi2 对 Mojang 的 `launchermeta/piston-meta/piston-data/
 * launcher` 路径是「同路径代理」，Maven 类资源统一挂在 `/maven/` 下，
 * Fabric meta 在 `/fabric-meta/`，Quilt meta 在 `/quilt-meta/`（只有基础
 * 列表，不含 per-game profile）。无法镜像的 host 原样返回，调用方仍可
 * 下载官方地址。
 */
export const BMCLAPI_ORIGIN = 'https://bmclapi2.bangbang93.com';

const MOJANG_HOSTS = new Set([
  'launchermeta.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
]);

const MAVEN_PREFIXES: Record<string, string> = {
  'maven.minecraftforge.net': '',
  'maven.neoforged.net': '/releases',
  'maven.fabricmc.net': '',
  'maven.quiltmc.org': '/repository/release',
};

const stripPrefix = (pathname: string, prefix: string): string => {
  if (!prefix) return pathname;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
};

/** 把官方 URL 改写到 BMCLAPI；官方镜像或无法识别的地址原样返回。 */
export const rewriteUrlForMirror = (value: string, mirror: Mirror): string => {
  if (mirror !== 'bmclapi' || !value) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return value;
  if (url.hostname.endsWith('.bangbang93.com')) return value;

  if (MOJANG_HOSTS.has(url.hostname)) {
    return `${BMCLAPI_ORIGIN}${url.pathname}${url.search}`;
  }

  if (url.hostname === 'libraries.minecraft.net') {
    return `${BMCLAPI_ORIGIN}/maven${url.pathname}${url.search}`;
  }

  if (url.hostname === 'resources.download.minecraft.net') {
    return `${BMCLAPI_ORIGIN}/assets${url.pathname}${url.search}`;
  }

  const mavenPrefix = MAVEN_PREFIXES[url.hostname];
  if (mavenPrefix !== undefined) {
    return `${BMCLAPI_ORIGIN}/maven${stripPrefix(url.pathname, mavenPrefix)}${url.search}`;
  }

  if (url.hostname === 'meta.fabricmc.net') {
    return `${BMCLAPI_ORIGIN}/fabric-meta${url.pathname}${url.search}`;
  }

  if (url.hostname === 'meta.quiltmc.org') {
    return `${BMCLAPI_ORIGIN}/quilt-meta${url.pathname}${url.search}`;
  }

  // files.minecraftforge.net（promotions_slim）没有 BMCLAPI 镜像。
  return value;
};

export const MOJANG_ASSET_BASE_URL = 'https://resources.download.minecraft.net';

export const assetBaseUrlForMirror = (mirror: Mirror): string => {
  const rewritten = rewriteUrlForMirror(MOJANG_ASSET_BASE_URL, mirror);
  // URL() 会把裸 host 的 pathname 归一成 '/'，重写后多出尾斜杠；
  // 与官方常量保持同形，启动器直接拼 hash 即可。
  return mirror === 'bmclapi' ? rewritten.replace(/\/+$/, '') : rewritten;
};
