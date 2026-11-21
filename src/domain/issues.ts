import { getDb, withTransaction } from '../db/database.ts';

/**
 * 议题（Issue）系统的最小存储层（SQLite 版）。
 *
 * 业务语义沿用 hydwind-web 的 JSON 实现：提交后先 pending，站务通过后 open；
 * 列表按 id 降序、回复按 id 升序。id 由 AUTOINCREMENT 生成，不再维护
 * JSON 里的 version/nextId。回复的 author 在 schema v2 中落库并原样读回。
 */

export const ISSUE_CATEGORIES = ['bug', 'suggestion', 'other'] as const;
export const ISSUE_STATUSES = ['pending', 'open', 'rejected', 'done'] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface IssueReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** 群内 / 站务回复标记，前端可用不同底色 */
  staff: boolean;
}

export interface Issue {
  id: number;
  title: string;
  body: string;
  author: string;
  category: IssueCategory;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  replies: IssueReply[];
}

/**
 * 旧 JSON 文件的外层结构。SQLite 版不再生成它，保留导出只为兼容旧调用方。
 */
export interface IssueList {
  version: 1;
  nextId: number;
  issues: Issue[];
}

const MAX_TITLE = 80;
const MAX_BODY = 2000;
const MAX_AUTHOR = 32;

const ISSUE_COLUMNS = 'id, title, body, category, status, author, created_at, updated_at';
const REPLY_COLUMNS = 'id, issue_id, author, body, staff, created_at';

const clamp = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
};

type IssueRow = {
  id: number | bigint;
  title: string;
  body: string;
  category: string;
  status: string;
  author: string | null;
  created_at: string;
  updated_at: string;
};

type ReplyRow = {
  id: number | bigint;
  issue_id: number | bigint;
  author: string;
  body: string;
  staff: number | bigint;
  created_at: string;
};

const categoryOf = (value: string): IssueCategory =>
  (ISSUE_CATEGORIES as readonly string[]).includes(value) ? (value as IssueCategory) : 'other';

const statusOf = (value: string): IssueStatus =>
  (ISSUE_STATUSES as readonly string[]).includes(value) ? (value as IssueStatus) : 'pending';

const replyFromRow = (row: ReplyRow): IssueReply => ({
  // 旧接口的回复 id 是 UUID 字符串；新表是 INTEGER，转回字符串保持对外类型不变。
  id: String(row.id),
  author: row.author,
  body: row.body,
  createdAt: row.created_at,
  staff: Number(row.staff) !== 0,
});

const issueFromRow = (row: IssueRow, replies: IssueReply[]): Issue => ({
  id: Number(row.id),
  title: row.title,
  body: row.body,
  author: row.author ?? '',
  category: categoryOf(row.category),
  status: statusOf(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  replies,
});

const repliesFor = (db: ReturnType<typeof getDb>, issueId: number | bigint): IssueReply[] => {
  const rows = db
    .prepare(`SELECT ${REPLY_COLUMNS} FROM issue_replies WHERE issue_id = ? ORDER BY id ASC`)
    .all(issueId) as ReplyRow[];
  return rows.map(replyFromRow);
};

export interface NewIssueInput {
  title: unknown;
  body: unknown;
  author: unknown;
  category: unknown;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const validateNewIssue = (
  input: NewIssueInput
): ValidationResult<{ title: string; body: string; author: string; category: IssueCategory }> => {
  const title = clamp(input.title, MAX_TITLE);
  const body = clamp(input.body, MAX_BODY);
  const author = clamp(input.author, MAX_AUTHOR) || '匿名玩家';
  const category = (ISSUE_CATEGORIES as readonly string[]).includes(String(input.category))
    ? (input.category as IssueCategory)
    : 'other';

  if (title.length < 4) return { ok: false, message: '标题至少 4 个字' };
  if (body.length < 10) return { ok: false, message: '描述至少 10 个字，方便我们定位问题' };

  return { ok: true, value: { title, body, author, category } };
};

export const createIssue = async (input: {
  title: string;
  body: string;
  author: string;
  category: IssueCategory;
}): Promise<Issue> => {
  return withTransaction((): Issue => {
    const db = getDb();
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO issues (title, body, category, status, author, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.title, input.body, input.category, 'pending', input.author, now, now);

    return {
      // lastInsertRowid 可能是 bigint；对外仍是 number。
      id: Number(result.lastInsertRowid),
      title: input.title,
      body: input.body,
      author: input.author,
      category: input.category,
      // 站内提交后先进待审队列，群里「通过」后才公开成 open
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      replies: [],
    };
  });
};

/** 未登录访客只看得到非 pending 的议题；pending 只在站务视角可见。 */
export const listIssues = async (options: { includePending?: boolean } = {}): Promise<Issue[]> => {
  const db = getDb();
  const rows = (
    options.includePending
      ? db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues ORDER BY id DESC`).all()
      : db
          .prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE status <> 'pending' ORDER BY id DESC`)
          .all()
  ) as IssueRow[];

  return rows.map((row) => issueFromRow(row, repliesFor(db, row.id)));
};

export const getIssue = async (id: number): Promise<Issue | undefined> => {
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;

  const db = getDb();
  const row = db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ?`).get(id) as
    | IssueRow
    | undefined;
  return row ? issueFromRow(row, repliesFor(db, row.id)) : undefined;
};

export const updateIssueStatus = async (
  id: number,
  status: IssueStatus
): Promise<Issue | undefined> => {
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;

  return withTransaction((): Issue | undefined => {
    const db = getDb();
    const row = db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ?`).get(id) as
      | IssueRow
      | undefined;
    if (!row) return undefined;

    const now = new Date().toISOString();
    db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      now,
      row.id
    );
    return issueFromRow({ ...row, status, updated_at: now }, repliesFor(db, row.id));
  });
};

export const addIssueReply = async (
  id: number,
  reply: { author: string; body: string; staff?: boolean }
): Promise<Issue | undefined> => {
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;

  return withTransaction((): Issue | undefined => {
    const db = getDb();
    const row = db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ?`).get(id) as
      | IssueRow
      | undefined;
    if (!row) return undefined;

    const now = new Date().toISOString();
    // 公开签名要求 author，运行时仍防御缺省值；空串表示匿名。
    const author = typeof reply.author === 'string' ? reply.author : '';
    db.prepare(
      'INSERT INTO issue_replies (issue_id, author, body, staff, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(row.id, author, reply.body, reply.staff ? 1 : 0, now);
    db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now, row.id);

    return issueFromRow({ ...row, updated_at: now }, repliesFor(db, row.id));
  });
};

export const isIssueStatus = (value: unknown): value is IssueStatus =>
  (ISSUE_STATUSES as readonly string[]).includes(String(value));