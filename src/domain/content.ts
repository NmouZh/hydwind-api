import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 站点内容的运行时解析。
 *
 * hydwind-web 用 astro:content 读取 `src/content`；独立后端不能依赖 Astro，
 * 所以这里直接读 Markdown 文件的 frontmatter。解析器只覆盖内容集实际用到的
 * 语法：`key: value`、带引号字符串、true/false、整数和 `key:` 后的块数组。
 */

export class HydwindContentError extends Error {
  /** 出错的内容文件，方便调用方定位。 */
  readonly path: string;

  constructor(message: string, filePath: string, cause?: unknown) {
    super(`${message}：${filePath}`, cause === undefined ? undefined : { cause });
    this.name = 'HydwindContentError';
    this.path = filePath;
  }
}

export interface SiteInfo {
  name: string;
  tagline: string;
  statusLabel: string;
  address: string;
  host: string;
  port: number;
  clientVersions: string;
  clientRequirement: string;
  versionNote: string;
  authentication: string;
  pricing: string;
  qqGroup: string;
  joinLimit: string;
  testingNotice: string;
  updated: string;
}

export interface PublishedPerson {
  id: string;
  data: {
    gameId: string;
    role: string;
    tags: string[];
    order: number;
    avatar: string;
    updated: string;
    published: boolean;
  };
  body: string;
}

type FrontmatterValue = string | number | boolean | string[];

interface ParsedMarkdown {
  data: Record<string, FrontmatterValue>;
  body: string;
}

/** 内容目录：环境变量优先，否则取工作区里 hydwind-web 的内容目录。 */
const contentDir = (): string => {
  const configured = process.env.HYDWIND_CONTENT_DIR;
  if (configured && configured.trim()) return configured;
  return path.join(process.cwd(), '..', 'hydwind-web', 'src', 'content');
};

const unquote = (value: string): string => {
  const match = /^(['"])([\s\S]*)\1$/.exec(value);
  return match ? match[2] : value;
};

/** 块数组里的元素一律按字符串处理，避免 `- 123` 变成数字标签。 */
const parseListItem = (value: string): string => unquote(value.trim());

const parseScalar = (raw: string): FrontmatterValue => {
  const value = raw.trim();
  if (/^(['"])[\s\S]*\1$/.test(value)) return unquote(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
};

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z][\w-]*):(?:[ \t]*(.*))?$/;
const LIST_LINE = /^[ \t]+-[ \t]*(.*)$/;

const parseMarkdown = (source: string, filePath: string): ParsedMarkdown => {
  const match = FRONTMATTER.exec(source);
  if (!match) {
    throw new HydwindContentError('缺少 frontmatter（需要 --- 包裹）', filePath);
  }

  const data: Record<string, FrontmatterValue> = {};
  let pendingKey: string | null = null;

  const lines = (match[1] ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    const listItem = LIST_LINE.exec(line);
    if (listItem) {
      if (!pendingKey) {
        throw new HydwindContentError(
          `frontmatter 第 ${index + 2} 行的列表项没有对应的键`,
          filePath
        );
      }
      const current = data[pendingKey];
      if (!Array.isArray(current)) data[pendingKey] = [];
      (data[pendingKey] as string[]).push(parseListItem(listItem[1]));
      continue;
    }

    const pair = KEY_LINE.exec(line);
    if (!pair) {
      throw new HydwindContentError(`无法解析 frontmatter 第 ${index + 2} 行`, filePath);
    }

    const key = pair[1];
    const raw = pair[2] ?? '';
    if (raw.trim() === '') {
      // `tags:` 后面可能跟块数组；先占位，等列表项或下一个键到来。
      pendingKey = key;
      data[key] = '';
    } else {
      pendingKey = null;
      data[key] = parseScalar(raw);
    }
  }

  return { data, body: source.slice(match[0].length).trim() };
};

const readContentFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HydwindContentError('内容文件不存在', filePath, error);
    }
    throw new HydwindContentError('读取内容文件失败', filePath, error);
  }
};

const optionalString = (value: FrontmatterValue | undefined): string => {
  if (value === undefined) return '';
  if (Array.isArray(value)) return '';
  return String(value);
};

const requiredString = (
  data: Record<string, FrontmatterValue>,
  key: string,
  filePath: string
): string => {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HydwindContentError(`缺少必填字段 ${key}`, filePath);
  }
  return value;
};

const requiredPort = (
  data: Record<string, FrontmatterValue>,
  filePath: string
): number => {
  const value = data.port;
  const port =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HydwindContentError('port 必须是 1-65535 的整数', filePath);
  }
  return port;
};

const optionalOrder = (value: FrontmatterValue | undefined): number => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return 999;
};

const optionalBoolean = (value: FrontmatterValue | undefined, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
};

const optionalTags = (value: FrontmatterValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => String(tag));
};

/** 站点单例；缺省 id 与 Web 内容集合保持一致。 */
export const getSite = async (): Promise<SiteInfo> => {
  const filePath = path.join(contentDir(), 'site', 'info.md');
  const source = await readContentFile(filePath);
  const { data } = parseMarkdown(source, filePath);

  return {
    name: requiredString(data, 'name', filePath),
    tagline: optionalString(data.tagline),
    statusLabel: optionalString(data.statusLabel),
    address: requiredString(data, 'address', filePath),
    host: requiredString(data, 'host', filePath),
    port: requiredPort(data, filePath),
    clientVersions: optionalString(data.clientVersions),
    clientRequirement: optionalString(data.clientRequirement),
    versionNote: optionalString(data.versionNote),
    authentication: optionalString(data.authentication),
    pricing: optionalString(data.pricing),
    qqGroup: optionalString(data.qqGroup),
    joinLimit: optionalString(data.joinLimit),
    testingNotice: optionalString(data.testingNotice),
    updated: optionalString(data.updated),
  };
};

/** 已发布的 curated 人物，按 order、gameId 排序；草稿不会出现在结果里。 */
export const getPublishedPeople = async (): Promise<PublishedPerson[]> => {
  const peopleDir = path.join(contentDir(), 'people');

  let names: string[];
  try {
    names = await readdir(peopleDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new HydwindContentError('读取人物目录失败', peopleDir, error);
  }

  const people: PublishedPerson[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;

    const filePath = path.join(peopleDir, name);
    const source = await readContentFile(filePath);
    const { data, body } = parseMarkdown(source, filePath);

    if (!optionalBoolean(data.published, true)) continue;

    const gameId = optionalString(data.gameId).trim();
    if (!gameId) continue;

    people.push({
      id: name.slice(0, -'.md'.length),
      data: {
        gameId,
        role: optionalString(data.role),
        tags: optionalTags(data.tags),
        order: optionalOrder(data.order),
        avatar: optionalString(data.avatar).trim() || `/api/avatar/${gameId}`,
        updated: optionalString(data.updated),
        published: true,
      },
      body,
    });
  }

  return people.sort(
    (a, b) =>
      a.data.order - b.data.order || a.data.gameId.localeCompare(b.data.gameId)
  );
};