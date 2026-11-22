import { crc32, deflateRawSync } from 'node:zlib';

/**
 * 确定性 ZIP 写入器。
 *
 * 用途是生成客户端包的 overrides.zip：同一组输入字节必须得到完全一致的
 * 输出，发布才能复现、哈希才能核对。为此：
 *
 * - 条目按完整路径排序（与传入顺序无关）；
 * - 时间戳固定为 DOS 纪元的 1980-01-01 00:00:00；
 * - 统一设置 UTF-8 标志位（general purpose bit 11）；
 * - 默认 deflate，可选 store，压缩级别固定为 9。
 *
 * 不写 ZIP64：调用方（overrides）有 50 MiB 上限，条目数与大小都远小于
 * 经典 ZIP 的 0xFFFF / 0xFFFFFFFF 边界。读取端可直接用 `zip.ts` 的
 * `readZipEntries`。安全边界与读取器一致：拒绝绝对路径、`..`、反斜杠、
 * 控制字符、Windows 保留字符和重复条目名。
 */

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipWriteError';
  }
}

export type ZipWriteMethod = 'deflate' | 'store';

export interface ZipWriteEntry {
  path: string;
  data: Buffer | Uint8Array;
}

export interface ZipWriteOptions {
  method?: ZipWriteMethod;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const validateEntryPath = (path: string): void => {
  if (!path) throw new ZipWriteError('ZIP 条目路径为空');
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new ZipWriteError(`ZIP 条目路径不合法: ${path}`);
  }
  if (/^[A-Za-z]:/.test(path) || /[\u0000-\u001f]/.test(path)) {
    throw new ZipWriteError(`ZIP 条目路径不合法: ${path}`);
  }
  // Windows 保留字符：与 client-pack 的路径规则保持一致，避免包在
  // Windows 启动器上无法解压。
  if (/[<>:"|?*]/.test(path)) {
    throw new ZipWriteError(`ZIP 条目路径不合法: ${path}`);
  }
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ZipWriteError(`ZIP 条目路径不合法: ${path}`);
  }
};

const toBuffer = (data: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(data) ? data : Buffer.from(data);

export const writeZipEntries = (
  entries: ZipWriteEntry[],
  options: ZipWriteOptions = {}
): Buffer => {
  const method = options.method ?? 'deflate';
  if (method !== 'deflate' && method !== 'store') {
    throw new ZipWriteError(`不支持的压缩方法: ${String(method)}`);
  }
  if (entries.length > MAX_ENTRIES) throw new ZipWriteError('ZIP 条目过多');

  const sorted = [...entries].sort((left, right) => comparePaths(left.path, right.path));

  const seen = new Set<string>();
  for (const entry of sorted) {
    validateEntryPath(entry.path);
    if (seen.has(entry.path)) throw new ZipWriteError(`ZIP 条目路径重复: ${entry.path}`);
    seen.add(entry.path);
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const data = toBuffer(entry.data);
    if (data.length > MAX_UINT32) throw new ZipWriteError(`ZIP 条目过大: ${entry.path}`);

    const methodId = method === 'store' ? METHOD_STORE : METHOD_DEFLATE;
    const payload =
      methodId === METHOD_STORE ? data : deflateRawSync(data, { level: 9 });
    if (payload.length > MAX_UINT32) throw new ZipWriteError(`ZIP 条目压缩后过大: ${entry.path}`);

    const name = Buffer.from(entry.path, 'utf8');
    if (name.length > 0xffff) throw new ZipWriteError(`ZIP 条目名过长: ${entry.path}`);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(methodId, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    central.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(methodId, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, payload);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
    if (offset > MAX_UINT32) throw new ZipWriteError('ZIP 总大小超出经典 ZIP 上限');
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, eocd]);
};