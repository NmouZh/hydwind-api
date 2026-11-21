import { ManifestError } from './errors.ts';
import type { Mirror } from './mirror.ts';
import { assetBaseUrlForMirror, rewriteUrlForMirror } from './mirror.ts';

/**
 * 版本 JSON → 启动器归一化清单。
 *
 * 这一层只做纯数据变换（规则过滤、legacy 参数、继承合并、路径生成），
 * 不发起网络请求。上游版本 JSON 和 Forge/NeoForge 的 `versionJson`
 * 都走同一套规则，启动器只需要理解一种形状。
 */

export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type OsName = 'windows' | 'osx' | 'linux';
export type ArchName = 'x86' | 'x86_64' | 'arm64';

export interface Platform {
  os: OsName;
  arch: ArchName;
}

export interface LoaderRef {
  type: LoaderType;
  version: string;
}

export interface ManifestFile {
  kind: 'client' | 'library' | 'native-classpath' | 'asset-index' | 'version-json' | 'installer';
  path: string;
  url: string;
  sha1: string;
  size: number;
  extract?: { exclude?: string[] };
}

export interface AssetIndexRef {
  id: string;
  path: string;
  url: string;
  sha1: string;
  size: number;
}

export interface NormalizedManifest {
  schemaVersion: 1;
  kind: 'manifest';
  id: string;
  gameVersion: string;
  loader: LoaderRef | null;
  os: OsName;
  arch: ArchName;
  java: { major: number; component?: string };
  mainClass: string;
  arguments: { jvm: string[]; defaultUserJvm: string[]; game: string[] };
  classpath: string[];
  files: ManifestFile[];
  natives: ManifestFile[];
  assetIndex: AssetIndexRef;
  assetBaseUrl: string;
}

export type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

export const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Mojang 版本 id 的合法字符集；也用于 `inheritsFrom`。 */
export const VERSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const isValidVersionId = (value: string): boolean => VERSION_ID_PATTERN.test(value);

const SAFE_SEGMENT = /^[A-Za-z0-9._+\-]+$/;

/**
 * 归一化相对路径：拒绝绝对路径、盘符、`..`、空段和控制字符。
 * 版本 JSON 里的 `downloads.artifact.path` 是不可信输入。
 */
export const safeRelativePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) throw new ManifestError('空路径');
  if (/^[A-Za-z]:/.test(normalized)) throw new ManifestError('不允许盘符路径');

  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || !SAFE_SEGMENT.test(part)) {
      throw new ManifestError(`非法路径: ${value}`);
    }
  }
  return normalized;
};

export interface MavenCoordinate {
  group: string;
  artifact: string;
  version: string;
  classifier: string;
  ext: string;
  path: string;
}

/** `group:artifact:version[:classifier][@ext]` → 坐标与仓库相对路径。 */
export const parseMavenCoordinate = (name: string): MavenCoordinate | null => {
  const at = name.lastIndexOf('@');
  const coordinate = at >= 0 ? name.slice(0, at) : name;
  const ext = at >= 0 ? name.slice(at + 1) : 'jar';
  if (!/^[A-Za-z0-9]+$/.test(ext)) return null;

  const parts = coordinate.split(':');
  if (parts.length < 3 || parts.length > 4) return null;
  const [group, artifact, version, classifier = ''] = parts;
  if (![group, artifact, version, classifier].every((part) => SAFE_SEGMENT.test(part))) {
    return null;
  }

  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  const path = `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
  return { group, artifact, version, classifier, ext, path };
};

export const normalizeOs = (value: string | null | undefined): OsName | null => {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'windows':
    case 'win':
    case 'win32':
      return 'windows';
    case 'osx':
    case 'macos':
    case 'mac':
    case 'darwin':
      return 'osx';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
};

export const normalizeArch = (value: string | null | undefined): ArchName | null => {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'x86_64':
    case 'x86-64':
    case 'amd64':
    case 'x64':
      return 'x86_64';
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x86':
    case 'i386':
    case 'i686':
    case '386':
      return 'x86';
    default:
      return null;
  }
};

export interface RuleContext extends Platform {
  features: Record<string, boolean>;
}

const osMatches = (ruleOs: JsonRecord, context: RuleContext): boolean => {
  const name = asString(ruleOs.name);
  if (name !== null) {
    const expected = normalizeOs(name);
    if (expected !== null ? expected !== context.os : name.toLowerCase() !== context.os) {
      return false;
    }
  }

  const arch = asString(ruleOs.arch);
  if (arch !== null) {
    const expected = normalizeArch(arch);
    if (expected !== null ? expected !== context.arch : arch.toLowerCase() !== context.arch) {
      return false;
    }
  }

  // os.versionRange 需要操作系统版本，启动器侧信息不足；按「匹配」处理，
  // 与 HMCL/PCL 在无法判断时的保守做法一致。
  return true;
};

const ruleMatches = (rule: JsonRecord, context: RuleContext): boolean => {
  const ruleOs = asRecord(rule.os);
  if (ruleOs && !osMatches(ruleOs, context)) return false;

  const features = asRecord(rule.features);
  if (features) {
    for (const [key, expected] of Object.entries(features)) {
      if (typeof expected !== 'boolean') continue;
      if ((context.features[key] ?? false) !== expected) return false;
    }
  }

  return true;
};

/**
 * Minecraft 规则语义：规则为空 → 允许；否则按顺序匹配，最后一条命中的
 * action 决定结果（未命中任何 allow 则不加载）。
 */
export const evaluateRules = (rules: unknown, context: RuleContext): boolean => {
  if (!Array.isArray(rules) || rules.length === 0) return true;

  let allowed = false;
  for (const item of rules) {
    const rule = asRecord(item);
    if (!rule || !ruleMatches(rule, context)) continue;
    if (rule.action === 'allow') allowed = true;
    else if (rule.action === 'disallow') allowed = false;
  }
  return allowed;
};

/** 解析 arguments 数组（字符串或 `{rules,value}`），按平台过滤并拍平。 */
export const resolveArguments = (value: unknown, context: RuleContext): string[] => {
  const out: string[] = [];

  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }

    const entry = asRecord(item);
    if (!entry || !evaluateRules(entry.rules, context)) continue;

    const entryValue = entry.value;
    if (typeof entryValue === 'string') out.push(entryValue);
    else if (Array.isArray(entryValue)) {
      for (const part of entryValue) {
        if (typeof part === 'string') out.push(part);
      }
    }
  }

  return out;
};

/** 1.8.9 等旧版的 `minecraftArguments` 是空格分隔字符串。 */
export const splitLegacyArguments = (value: string): string[] => {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasToken) {
        out.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (hasToken) out.push(current);
  return out;
};

const mergeUrl = (baseUrl: string, path: string): string => {
  try {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(path, base).toString();
  } catch {
    return '';
  }
};

const extractFromLibrary = (library: JsonRecord): { exclude?: string[] } | undefined => {
  const extract = asRecord(library.extract);
  if (!extract) return undefined;
  const exclude = asArray(extract.exclude).filter(
    (item): item is string => typeof item === 'string'
  );
  return { exclude };
};

interface LibraryResult {
  files: ManifestFile[];
  natives: ManifestFile[];
  classpath: string[];
}

const libraryFiles = (
  libraries: unknown[],
  context: RuleContext,
  mirror: Mirror
): LibraryResult => {
  const files: ManifestFile[] = [];
  const natives: ManifestFile[] = [];
  const classpath: string[] = [];

  for (const item of libraries) {
    const library = asRecord(item);
    if (!library || !evaluateRules(library.rules, context)) continue;

    const name = asString(library.name) ?? '';
    const coordinate = name ? parseMavenCoordinate(name) : null;
    const downloads = asRecord(library.downloads);
    const artifact = asRecord(downloads?.artifact);
    const baseUrl = asString(library.url) ?? '';

    let path = asString(artifact?.path) ?? coordinate?.path ?? '';
    if (!path) continue;
    path = safeRelativePath(path);

    let url = asString(artifact?.url) ?? '';
    if (!url && baseUrl) url = mergeUrl(baseUrl, path);
    if (!url) {
      // Forge 的 patched client 库刻意没有 URL（安装器生成），不能构造下载。
      continue;
    }

    const sha1 = asString(artifact?.sha1) ?? asString(library.sha1) ?? '';
    const size = asNumber(artifact?.size) ?? asNumber(library.size) ?? 0;
    const file: ManifestFile = {
      kind: 'library',
      path,
      url: rewriteUrlForMirror(url, mirror),
      sha1,
      size,
    };

    files.push(file);
    classpath.push(path);

    const nativesMap = asRecord(library.natives);
    if (!nativesMap) continue;

    const classifierKey = asString(nativesMap[context.os]);
    if (!classifierKey) continue;

    const classifiers = asRecord(downloads?.classifiers);
    const nativeArtifact = asRecord(classifiers?.[classifierKey]);
    const nativePath = safeRelativePath(
      asString(nativeArtifact?.path) ??
        coordinate?.path.replace(/\.jar$/, `-${classifierKey}.jar`) ??
        ''
    );
    let nativeUrl = asString(nativeArtifact?.url) ?? '';
    if (!nativeUrl && baseUrl) nativeUrl = mergeUrl(baseUrl, nativePath);
    if (!nativeUrl) continue;

    const nativeFile: ManifestFile = {
      kind: 'native-classpath',
      path: nativePath,
      url: rewriteUrlForMirror(nativeUrl, mirror),
      sha1: asString(nativeArtifact?.sha1) ?? '',
      size: asNumber(nativeArtifact?.size) ?? 0,
    };
    const extract = extractFromLibrary(library);
    if (extract) nativeFile.extract = extract;

    natives.push(nativeFile);
  }

  // 同一个库被继承链重复列出时，classpath 只保留第一次出现的路径。
  return { files, natives, classpath: [...new Set(classpath)] };
};

export interface NormalizeOptions {
  platform: Platform;
  mirror: Mirror;
  id: string;
  gameVersion: string;
  loader: LoaderRef | null;
  versionJsonFile?: { url: string; sha1: string; size: number };
  features?: Record<string, boolean>;
}

/** 把（可能已合并继承的）版本 JSON 归一化成启动器清单。 */
export const normalizeVersionJson = (
  raw: JsonRecord,
  options: NormalizeOptions
): NormalizedManifest => {
  const context: RuleContext = {
    os: options.platform.os,
    arch: options.platform.arch,
    features: options.features ?? {},
  };

  const rawArguments = asRecord(raw.arguments) ?? {};
  const jvm = resolveArguments(rawArguments.jvm, context);
  const game = resolveArguments(rawArguments.game, context);
  const legacyArguments = asString(raw.minecraftArguments);
  if (legacyArguments && game.length === 0) {
    game.push(...splitLegacyArguments(legacyArguments));
  }
  const defaultUserJvm = resolveArguments(rawArguments['default-user-jvm'], context);

  const javaVersion = asRecord(raw.javaVersion);
  const javaMajor = asNumber(javaVersion?.majorVersion) ?? 8;
  const javaComponent = asString(javaVersion?.component);
  const java = javaComponent ? { major: javaMajor, component: javaComponent } : { major: javaMajor };

  const assetIndexRaw = asRecord(raw.assetIndex);
  const assetId =
    asString(assetIndexRaw?.id) ?? asString(raw.assets) ?? 'legacy';
  const assetIndexPath = safeRelativePath(`assets/indexes/${assetId}.json`);
  const assetIndex: AssetIndexRef = {
    id: assetId,
    path: assetIndexPath,
    url: rewriteUrlForMirror(asString(assetIndexRaw?.url) ?? '', options.mirror),
    sha1: asString(assetIndexRaw?.sha1) ?? '',
    size: asNumber(assetIndexRaw?.size) ?? 0,
  };

  const client = asRecord(asRecord(raw.downloads)?.client);
  const clientFile: ManifestFile | null = client
    ? {
        kind: 'client',
        path: safeRelativePath(`versions/${options.gameVersion}/${options.gameVersion}.jar`),
        url: rewriteUrlForMirror(asString(client.url) ?? '', options.mirror),
        sha1: asString(client.sha1) ?? '',
        size: asNumber(client.size) ?? 0,
      }
    : null;

  const libraryResult = libraryFiles(asArray(raw.libraries), context, options.mirror);

  const assetFile: ManifestFile = {
    kind: 'asset-index',
    path: assetIndex.path,
    url: assetIndex.url,
    sha1: assetIndex.sha1,
    size: assetIndex.size,
  };

  const files: ManifestFile[] = [];
  if (clientFile) files.push(clientFile);
  files.push(...libraryResult.files, ...libraryResult.natives, assetFile);

  if (options.versionJsonFile) {
    files.push({
      kind: 'version-json',
      path: safeRelativePath(`versions/${options.id}/${options.id}.json`),
      url: rewriteUrlForMirror(options.versionJsonFile.url, options.mirror),
      sha1: options.versionJsonFile.sha1,
      size: options.versionJsonFile.size,
    });
  }

  return {
    schemaVersion: 1,
    kind: 'manifest',
    id: options.id,
    gameVersion: options.gameVersion,
    loader: options.loader,
    os: options.platform.os,
    arch: options.platform.arch,
    java,
    mainClass: asString(raw.mainClass) ?? '',
    arguments: { jvm, defaultUserJvm, game },
    classpath: libraryResult.classpath,
    files,
    natives: libraryResult.natives,
    assetIndex,
    assetBaseUrl: assetBaseUrlForMirror(options.mirror),
  };
};

const rawArgumentsList = (value: unknown): unknown[] => asArray(value);

const legacyRawArguments = (raw: JsonRecord): unknown[] => {
  const legacy = asString(raw.minecraftArguments);
  return legacy ? splitLegacyArguments(legacy) : [];
};

const libraryIdentity = (library: JsonRecord): string => {
  const name = asString(library.name) ?? '';
  const coordinate = name ? parseMavenCoordinate(name) : null;
  const base = coordinate
    ? `${coordinate.group}:${coordinate.artifact}:${coordinate.classifier}`
    : name;
  return [
    base,
    JSON.stringify(library.rules ?? null),
    JSON.stringify(library.natives ?? null),
  ].join('|');
};

/** 子版本优先、父版本在后；同 group:artifact:classifier 且规则相同只留子版本。 */
export const dedupeLibraries = (libraries: unknown[]): unknown[] => {
  const seen = new Set<string>();
  const out: unknown[] = [];

  for (const item of libraries) {
    const library = asRecord(item);
    if (!library) continue;
    const identity = libraryIdentity(library);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(library);
  }

  return out;
};

/**
 * 合并 `inheritsFrom`：标量子优先，libraries 子在前，arguments 父在前子在后。
 * legacy `minecraftArguments` 在这一步转成 arguments.game 数组，避免下游
 * 再区分两套参数格式。
 */
export const mergeVersionJson = (parent: JsonRecord, child: JsonRecord): JsonRecord => {
  const parentArguments = asRecord(parent.arguments) ?? {};
  const childArguments = asRecord(child.arguments) ?? {};

  const parentGame = [
    ...legacyRawArguments(parent),
    ...rawArgumentsList(parentArguments.game),
  ];
  const childGame = [
    ...legacyRawArguments(child),
    ...rawArgumentsList(childArguments.game),
  ];
  const parentJvm = rawArgumentsList(parentArguments.jvm);
  const childJvm = rawArgumentsList(childArguments.jvm);

  const childDefaultUserJvm = childArguments['default-user-jvm'];
  const defaultUserJvm =
    childDefaultUserJvm !== undefined
      ? childDefaultUserJvm
      : parentArguments['default-user-jvm'];

  const merged: JsonRecord = { ...parent, ...child };
  delete merged.inheritsFrom;
  delete merged.minecraftArguments;

  merged.arguments = {
    ...parentArguments,
    ...childArguments,
    game: [...parentGame, ...childGame],
    jvm: [...parentJvm, ...childJvm],
  };
  if (defaultUserJvm !== undefined) {
    (merged.arguments as JsonRecord)['default-user-jvm'] = defaultUserJvm;
  } else {
    delete (merged.arguments as JsonRecord)['default-user-jvm'];
  }

  merged.libraries = dedupeLibraries([
    ...asArray(child.libraries),
    ...asArray(parent.libraries),
  ]);

  const childDownloads = asRecord(child.downloads);
  const parentDownloads = asRecord(parent.downloads);
  if (childDownloads || parentDownloads) {
    merged.downloads = { ...(parentDownloads ?? {}), ...(childDownloads ?? {}) };
  }

  if (merged.jar === undefined) merged.jar = child.jar ?? parent.jar ?? child.id;
  if (merged.mainClass === undefined) merged.mainClass = parent.mainClass;

  return merged;
};

/** 规则过滤的公开入口，便于单测直接覆盖 features/os/arch。 */
export const filterArguments = resolveArguments;
