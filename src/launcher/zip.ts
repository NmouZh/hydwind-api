import { inflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 读取器（只用于 Forge/NeoForge 安装器）。
 *
 * 不新增依赖：读 EOCD → 中央目录 → 本地文件头，只解压需要的 JSON 条目。
 * 安全边界按解压炸弹处理：条目数、单条大小、总大小和压缩比都设上限；
 * 不落盘，因而不存在路径穿越的解压目标，但仍然拒绝 `..` 条目名。
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

const normalizeEntryName = (name: string): string | null => {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null;
  return normalized;
};

const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const start = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('找不到 ZIP 中央目录');
};

export const readZipEntries = (input: Buffer | Uint8Array): Map<string, Buffer> => {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipError('ZIP 文件过小');

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (entryCount > MAX_ENTRIES) throw new ZipError('ZIP 条目过多');
  if (directoryOffset + directorySize > buffer.length) throw new ZipError('ZIP 中央目录越界');
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new ZipError('不支持 ZIP64');
  }

  const entries = new Map<string, Buffer>();
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
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length) throw new ZipError('ZIP 中央目录截断');

    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset = nextOffset;

    const name = normalizeEntryName(rawName);
    if (!name) continue;

    if (flags & 0x1) throw new ZipError('不支持加密的 ZIP 条目');
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方法: ${method}`);
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) throw new ZipError('ZIP 条目过大');
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
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

    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
      } catch {
        throw new ZipError(`解压 ZIP 条目失败: ${name}`);
      }
    }

    if (content.length !== uncompressedSize) throw new ZipError(`ZIP 条目大小不匹配: ${name}`);
    totalUncompressed += content.length;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new ZipError('ZIP 解压总量过大');

    if (!entries.has(name)) entries.set(name, content);
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
