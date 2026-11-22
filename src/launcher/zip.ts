import { inflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 读取器（Forge/NeoForge 安装器与 overrides 校验共用）。
 *
 * 不新增依赖：读 EOCD → 中央目录 → 本地文件头，只解压需要的 JSON 条目。
 * 安全边界按解压炸弹处理：条目数、单条大小、总大小和压缩比都有默认上限，
 * 调用方可以按用途覆盖（overrides 与安装器的上限不同）；不落盘，因而不
 * 存在路径穿越的解压目标。
 *
 * 默认模式保持安装器行为：非法名规范化后跳过。strict 模式供 overrides
 * 使用：不做规范化、不跳过，任何非法/特殊/重复条目都直接拒绝。
 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 5_000;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 8 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

/**
 * 读取上限。默认值保持安装器现状；overrides 等场景可放宽（总量/单条目
 * 由调用方自己保证）。
 */
export interface ZipReadLimits {
  maxEntries?: number;
  maxTotalUncompressed?: number;
  maxEntryUncompressed?: number;
  maxCompressionRatio?: number;
  /**
   * 严格模式（overrides 使用）：不做名称规范化或静默跳过。
   * 每个条目先完成加密/压缩方法/大小/压缩比/越界检查，再拒绝绝对名、
   * 反斜杠、控制字符、非法段、Windows 保留名/冒号/非法字符、目录、
   * 符号链接/特殊类型、重复条目以及本地头名称不一致。
   */
  strict?: boolean;
}

const normalizeEntryName = (name: string): string | null => {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null;
  return normalized;
};

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_ILLEGAL_NAME_CHAR = /[<>"|?*]/;

const strictEntryNameIssue = (name: string): string | null => {
  if (!name) return 'ZIP 条目名为空';
  if (name.startsWith('/')) return `ZIP 条目名不能是绝对路径: ${name}`;
  if (name.includes('\\')) return `ZIP 条目名不能包含反斜杠: ${name}`;
  if (/[\u0000-\u001f]/.test(name)) return `ZIP 条目名包含控制字符: ${name}`;
  if (WINDOWS_ILLEGAL_NAME_CHAR.test(name)) {
    return `ZIP 条目名包含 Windows 非法字符: ${name}`;
  }
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `ZIP 条目名包含空段、. 或 ..: ${name}`;
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return `ZIP 条目名路径段不能以点或空格结尾: ${name}`;
    }
    if (segment.includes(':')) return `ZIP 条目名不能包含冒号: ${name}`;
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return `ZIP 条目名不能是 Windows 保留设备名: ${name}`;
    }
  }
  return null;
};

/** 严格模式拒绝目录、符号链接和 Unix 特殊类型；DOS 目录位同样视为目录。 */
const entryKindIssue = (name: string, externalAttrs: number): string | null => {
  const unixType = (externalAttrs >>> 16) & 0o170000;
  if (unixType === 0o120000) return `ZIP 不允许符号链接条目: ${name}`;
  if (
    name.endsWith('/') ||
    unixType === 0o040000 ||
    (externalAttrs & 0x10) !== 0
  ) {
    return `ZIP 不允许目录条目: ${name}`;
  }
  if (unixType !== 0 && unixType !== 0o100000) {
    return `ZIP 条目不是普通文件: ${name}`;
  }
  return null;
};

const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const start = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('找不到 ZIP 中央目录');
};

export const readZipEntries = (
  input: Buffer | Uint8Array,
  limits: ZipReadLimits = {}
): Map<string, Buffer> => {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxTotalUncompressed = limits.maxTotalUncompressed ?? MAX_TOTAL_UNCOMPRESSED;
  const maxEntryUncompressed = limits.maxEntryUncompressed ?? MAX_ENTRY_UNCOMPRESSED;
  const maxCompressionRatio = limits.maxCompressionRatio ?? MAX_COMPRESSION_RATIO;
  const strict = limits.strict === true;

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipError('ZIP 文件过小');

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (directoryOffset + directorySize > buffer.length) throw new ZipError('ZIP 中央目录越界');
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new ZipError('不支持 ZIP64');
  }

  const entries = new Map<string, Buffer>();
  const seenNames = new Set<string>();
  const seenLowerNames = new Set<string>();
  // 只把文件条目计入 maxEntries；目录条目即使不参与解压也不占配额。
  let fileEntries = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) throw new ZipError('ZIP 中央目录截断');
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError('ZIP 中央目录签名不匹配');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length) throw new ZipError('ZIP 中央目录截断');

    const rawNameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = rawNameBytes.toString('utf8');
    offset = nextOffset;

    let name: string;
    if (strict) {
      // 严格模式不做规范化，等安全/上限检查全部通过后再拒绝非法名称。
      name = rawName;
    } else {
      const normalized = normalizeEntryName(rawName);
      if (!normalized) continue;
      name = normalized;
      fileEntries += 1;
      if (fileEntries > maxEntries) throw new ZipError('ZIP 条目过多');
    }

    if (flags & 0x1) throw new ZipError('不支持加密的 ZIP 条目');
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方法: ${method}`);
    if (uncompressedSize > maxEntryUncompressed) throw new ZipError('ZIP 条目过大');
    if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) {
      throw new ZipError('ZIP 压缩比异常');
    }
    if (localOffset + 30 > buffer.length) throw new ZipError('ZIP 本地文件头越界');
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError('ZIP 本地文件头签名不匹配');
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw new ZipError('ZIP 条目数据越界');

    if (strict) {
      const localNameBytes = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
      if (!localNameBytes.equals(rawNameBytes)) {
        throw new ZipError(`ZIP 本地文件头名称与中央目录不一致: ${rawName}`);
      }

      const kindIssue = entryKindIssue(rawName, externalAttrs);
      if (kindIssue) throw new ZipError(kindIssue);

      const nameIssue = strictEntryNameIssue(rawName);
      if (nameIssue) throw new ZipError(nameIssue);

      if (seenNames.has(rawName)) throw new ZipError(`ZIP 条目重复: ${rawName}`);
      const lowerName = rawName.toLowerCase();
      if (seenLowerNames.has(lowerName)) {
        throw new ZipError(`ZIP 条目仅大小写不同而重复: ${rawName}`);
      }

      // 上限只统计可接受的文件条目；目录/非法名已在上方拒绝。
      fileEntries += 1;
      if (fileEntries > maxEntries) throw new ZipError('ZIP 条目过多');

      seenNames.add(rawName);
      seenLowerNames.add(lowerName);
    }

    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: maxEntryUncompressed });
      } catch {
        throw new ZipError(`解压 ZIP 条目失败: ${name}`);
      }
    }

    if (content.length !== uncompressedSize) throw new ZipError(`ZIP 条目大小不匹配: ${name}`);
    totalUncompressed += content.length;
    if (totalUncompressed > maxTotalUncompressed) throw new ZipError('ZIP 解压总量过大');

    if (!entries.has(name)) entries.set(name, content);
  }

  // 严格模式不允许 EOCD 条目数与中央目录实际内容不一致，
  // 否则隐藏的额外条目可能被其它解压器看到而绕开清单比对。
  if (strict && offset !== directoryOffset + directorySize) {
    throw new ZipError('ZIP 中央目录条目数与目录大小不一致');
  }

  return entries;
};

/** 读取 ZIP 内 JSON；缺条目或坏 JSON 都抛 ZipError。 */
export const readZipJson = (entries: Map<string, Buffer>, name: string): unknown => {
  const normalized = name.replace(/^\/+/, '');
  const content = entries.get(normalized);
  if (!content) throw new ZipError(`ZIP 缺少条目: ${normalized}`);
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new ZipError(`ZIP 条目不是合法 JSON: ${normalized}`);
  }
};
