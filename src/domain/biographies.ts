import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, withTransaction } from '../db/database.ts';
import { consumeRateLimit } from './rate-limit.ts';
import { canDeleteCommentForAuthor } from './person-page.ts';
import {
  MAX_BIO_BODY,
  MAX_BIO_TITLE,
  MIN_BIO_TITLE,
  MAX_COMMENT_BODY,
  MIN_COMMENT_BODY,
} from './biography-limits.ts';

/**
 * 人物传记存储层（SQLite 版）。
 *
 * 业务语义沿用 hydwind-web 的 JSON 实现：按账号游戏 ID（`account.username`）
 * 存传记，一个玩家一篇；评论单独存表，`gameId` 比较一律忽略大小写。
 *
 * SQLite 与原 JSON 的两处结构差异在此处理：
 * - 评论从传记内嵌数组变成 comments 表，读取时按 created_at（同毫秒按 rowid）排序，
 *   保持旧数组的插入顺序。
 * - comments.game_id 有外键指向 biographies.game_id。账号改名迁移时，父键和
 *   子键必须在同一个事务里一起改，事务内用 PRAGMA defer_foreign_keys 延迟到提交时校验。
 */

// 长度限制放在纯模块里，浏览器端预校验与服务端共用同一组数字。
export {
  MAX_BIO_BODY,
  MAX_BIO_TITLE,
  MIN_BIO_TITLE,
  MAX_COMMENT_BODY,
  MIN_COMMENT_BODY,
} from './biography-limits.ts';

/** 每个账号在窗口内最多发这么多条评论。 */
export const COMMENT_RATE_LIMIT = 5;
export const COMMENT_RATE_WINDOW_MS = 10 * 60_000;

export interface Comment {
  id: string;
  /** 发表评论的账号名，用来判断「谁能删」 */
  authorUsername: string;
  /** 发表评论时的游戏 ID，展示与后续迁移用 */
  authorGameId: string;
  body: string;
  createdAt: string;
}

export interface Biography {
  /** 账号 username，也就是游戏 ID；比较时忽略大小写 */
  gameId: string;
  mainTitle: string;
  /** Markdown 正文，允许为空 */
  body: string;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

const BIOGRAPHY_COLUMNS = 'game_id, main_title, body, created_at, updated_at';
const COMMENT_COLUMNS = 'id, game_id, author_username, author_game_id, body, created_at';

type BiographyRow = {
  game_id: string;
  main_title: string;
  body: string;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: string;
  game_id: string;
  author_username: string;
  author_game_id: string;
  body: string;
  created_at: string;
};

const commentFromRow = (row: CommentRow): Comment => ({
  id: row.id,
  authorUsername: row.author_username,
  authorGameId: row.author_game_id,
  body: row.body,
  createdAt: row.created_at,
});

const biographyFromRow = (row: BiographyRow, comments: Comment[]): Biography => ({
  gameId: row.game_id,
  mainTitle: row.main_title,
  body: row.body,
  comments,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** 「字」按 Unicode 码点算，避免 emoji 被算成两个字。 */
const textLength = (value: string): number => [...value].length;

const findRow = (db: DatabaseSync, gameId: string): BiographyRow | undefined => {
  const key = typeof gameId === 'string' ? gameId.trim() : '';
  if (!key) return undefined;
  return db
    .prepare(`SELECT ${BIOGRAPHY_COLUMNS} FROM biographies WHERE game_id COLLATE NOCASE = ?`)
    .get(key) as BiographyRow | undefined;
};

const commentsFor = (db: DatabaseSync, gameId: string): Comment[] => {
  const rows = db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE game_id COLLATE NOCASE = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(gameId) as CommentRow[];
  return rows.map(commentFromRow);
};

/* ------------------------------------------------------------------ *
 * 新领域模型
 * ------------------------------------------------------------------ */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type DomainFailureReason = 'invalid' | 'not_found' | 'forbidden' | 'rate_limited';

export type DomainResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: DomainFailureReason;
      message: string;
      /** 仅 rate_limited 有值 */
      retryAfterMs?: number;
    };

export interface EditAccount {
  username: string;
  role: string;
}

export interface CommentAuthor {
  /** 账号 username，也就是评论作者的游戏 ID。 */
  username: string;
}

export const defaultMainTitle = (gameId: string): string => `${gameId}的人物传记`;

export const validateMainTitle = (input: unknown, gameId: string): ValidationResult<string> => {
  const fallback = defaultMainTitle(gameId);
  if (input === undefined || input === null) return { ok: true, value: fallback };
  if (typeof input !== 'string') return { ok: false, message: '主标题需要是文本' };

  const value = input.trim();
  if (!value) return { ok: true, value: fallback };

  const length = textLength(value);
  if (length < MIN_BIO_TITLE) {
    return { ok: false, message: `主标题至少 ${MIN_BIO_TITLE} 个字` };
  }
  if (length > MAX_BIO_TITLE) {
    return { ok: false, message: `主标题最多 ${MAX_BIO_TITLE} 个字` };
  }
  return { ok: true, value };
};

export const validateBiographyBody = (input: unknown): ValidationResult<string> => {
  if (typeof input !== 'string') return { ok: false, message: '正文需要是文本' };
  // 保存时保留作者写的首尾空行；trim 只用来判断空正文和计算长度。
  if (textLength(input.trim()) > MAX_BIO_BODY) {
    return { ok: false, message: `正文最多 ${MAX_BIO_BODY} 个字` };
  }
  return { ok: true, value: input };
};

export const validateCommentBody = (input: unknown): ValidationResult<string> => {
  if (typeof input !== 'string') return { ok: false, message: '评论需要是文本' };
  const value = input.trim();
  const length = textLength(value);
  if (length < MIN_COMMENT_BODY) return { ok: false, message: '评论不能为空' };
  if (length > MAX_COMMENT_BODY) {
    return { ok: false, message: `评论最多 ${MAX_COMMENT_BODY} 个字` };
  }
  return { ok: true, value };
};

export interface BiographyInput {
  mainTitle?: unknown;
  body?: unknown;
}

export interface PreparedBiographyContent {
  mainTitle: string;
  body: string;
}

export const validateBiographyInput = (
  input: BiographyInput,
  gameId: string
): ValidationResult<PreparedBiographyContent> => {
  const mainTitle = validateMainTitle(input.mainTitle, gameId);
  if (!mainTitle.ok) return mainTitle;
  const body = validateBiographyBody(input.body);
  if (!body.ok) return body;
  return { ok: true, value: { mainTitle: mainTitle.value, body: body.value } };
};

/** 按账号 username 建默认传记；已有则原样返回（幂等）。 */
export const ensureBiographyForAccount = async (account: { username: string }): Promise<Biography> => {
  const gameId = typeof account?.username === 'string' ? account.username.trim() : '';
  if (!gameId) throw new Error('账号 username 不能为空');

  return withTransaction((): Biography => {
    const db = getDb();
    const existing = findRow(db, gameId);
    if (existing) return biographyFromRow(existing, commentsFor(db, existing.game_id));

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO biographies (${BIOGRAPHY_COLUMNS}) VALUES (?, ?, ?, ?, ?)`
    ).run(gameId, defaultMainTitle(gameId), '', now, now);

    return {
      gameId,
      mainTitle: defaultMainTitle(gameId),
      body: '',
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
  });
};

export const findBiographyByGameId = async (gameId: string): Promise<Biography | null> => {
  const db = getDb();
  const row = findRow(db, gameId);
  return row ? biographyFromRow(row, commentsFor(db, row.game_id)) : null;
};

export const listGameBiographies = async (): Promise<Biography[]> => {
  const db = getDb();
  const rows = db.prepare(`SELECT ${BIOGRAPHY_COLUMNS} FROM biographies`).all() as BiographyRow[];
  const commentRows = db
    .prepare(`SELECT ${COMMENT_COLUMNS} FROM comments ORDER BY created_at ASC, rowid ASC`)
    .all() as CommentRow[];

  // game_id 是 NOCASE 主键，大小写变体属于同一篇；按小写分组即可。
  const byGame = new Map<string, Comment[]>();
  for (const row of commentRows) {
    const key = row.game_id.trim().toLowerCase();
    const comments = byGame.get(key);
    if (comments) comments.push(commentFromRow(row));
    else byGame.set(key, [commentFromRow(row)]);
  }

  return rows
    .map((row) => biographyFromRow(row, byGame.get(row.game_id.trim().toLowerCase()) ?? []))
    .sort((a, b) => a.gameId.localeCompare(b.gameId));
};

/**
 * 保存标题与正文。传记不存在时顺手建一份，调用方负责校验编辑权限。
 * 未传的字段保持原值（新建时则用默认值），空标题回退默认标题。
 */
export const updateBiography = async (
  gameId: string,
  input: BiographyInput
): Promise<DomainResult<Biography>> => {
  const key = typeof gameId === 'string' ? gameId.trim() : '';
  if (!key) return { ok: false, reason: 'invalid', message: '缺少游戏 ID' };

  return withTransaction((): DomainResult<Biography> => {
    const db = getDb();
    const existing = findRow(db, key);
    const now = new Date().toISOString();

    const titleInput = input.mainTitle === undefined ? existing?.main_title ?? '' : input.mainTitle;
    const bodyInput = input.body === undefined ? existing?.body ?? '' : input.body;

    const title = validateMainTitle(titleInput, existing?.game_id ?? key);
    if (!title.ok) return { ok: false, reason: 'invalid', message: title.message };
    const body = validateBiographyBody(bodyInput);
    if (!body.ok) return { ok: false, reason: 'invalid', message: body.message };

    if (existing) {
      db.prepare(
        'UPDATE biographies SET main_title = ?, body = ?, updated_at = ? WHERE game_id = ?'
      ).run(title.value, body.value, now, existing.game_id);
      return {
        ok: true,
        value: biographyFromRow(
          { ...existing, main_title: title.value, body: body.value, updated_at: now },
          commentsFor(db, existing.game_id)
        ),
      };
    }

    db.prepare(
      `INSERT INTO biographies (${BIOGRAPHY_COLUMNS}) VALUES (?, ?, ?, ?, ?)`
    ).run(key, title.value, body.value, now, now);

    return {
      ok: true,
      value: {
        gameId: key,
        mainTitle: title.value,
        body: body.value,
        comments: [],
        createdAt: now,
        updatedAt: now,
      },
    };
  });
};

/** 本人或管理员可以编辑。传记是否存在不影响判断，权限只看账号与目标游戏 ID。 */
export const canEditBiography = (account: EditAccount | null, gameId: string): boolean => {
  if (!account) return false;
  if (account.role === 'admin') return true;
  return account.username.toLowerCase() === gameId.trim().toLowerCase();
};

export const listComments = async (gameId: string): Promise<Comment[]> => {
  const db = getDb();
  const biography = findRow(db, gameId);
  if (!biography) return [];
  return commentsFor(db, biography.game_id);
};

export const addComment = async (
  gameId: string,
  author: CommentAuthor,
  body: unknown
): Promise<DomainResult<Comment>> => {
  const key = typeof gameId === 'string' ? gameId.trim() : '';
  const username = typeof author?.username === 'string' ? author.username.trim() : '';
  if (!key || !username) {
    return { ok: false, reason: 'invalid', message: '缺少游戏 ID 或作者账号' };
  }

  const validated = validateCommentBody(body);
  if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.message };

  return withTransaction((): DomainResult<Comment> => {
    const db = getDb();
    const biography = findRow(db, key);
    if (!biography) return { ok: false, reason: 'not_found', message: '没有找到这份传记' };

    const limit = consumeRateLimit(
      `biography-comment:${username.toLowerCase()}`,
      COMMENT_RATE_LIMIT,
      COMMENT_RATE_WINDOW_MS
    );
    if (!limit.ok) {
      return {
        ok: false,
        reason: 'rate_limited',
        message: '评论太频繁啦，过几分钟再试',
        retryAfterMs: limit.retryAfterMs,
      };
    }

    const now = new Date().toISOString();
    const comment: Comment = {
      id: randomUUID(),
      authorUsername: username,
      authorGameId: username,
      body: validated.value,
      createdAt: now,
    };
    db.prepare(
      `INSERT INTO comments (${COMMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      comment.id,
      biography.game_id,
      comment.authorUsername,
      comment.authorGameId,
      comment.body,
      comment.createdAt
    );

    return { ok: true, value: comment };
  });
};

export const deleteComment = async (
  gameId: string,
  commentId: string,
  actor: EditAccount | null
): Promise<DomainResult<Comment>> => {
  if (!actor) return { ok: false, reason: 'forbidden', message: '先登录再删除评论' };

  return withTransaction((): DomainResult<Comment> => {
    const db = getDb();
    const biography = findRow(db, gameId);
    if (!biography) return { ok: false, reason: 'not_found', message: '没有找到这份传记' };
    if (typeof commentId !== 'string' || !commentId) {
      return { ok: false, reason: 'not_found', message: '没有找到这条评论' };
    }

    const row = db
      .prepare(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = ? AND game_id = ?`)
      .get(commentId, biography.game_id) as CommentRow | undefined;
    if (!row) return { ok: false, reason: 'not_found', message: '没有找到这条评论' };

    const comment = commentFromRow(row);
    if (!canDeleteCommentForAuthor(comment.authorUsername, actor)) {
      return { ok: false, reason: 'forbidden', message: '只能删除自己的评论' };
    }

    db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    return { ok: true, value: comment };
  });
};

/* ------------------------------------------------------------------ *
 * slug 解析与账号改名迁移
 * ------------------------------------------------------------------ */

export interface StaticPersonRef {
  id: string;
  gameId: string;
}

export interface SlugLookup {
  /** 静态内容集合里的人物；调用方负责从 astro:content 取。 */
  staticPeople: ReadonlyArray<StaticPersonRef>;
  /** 按账号名查找；调用方通常传 `findAccount`。 */
  findAccount: (username: string) => Promise<{ username: string } | undefined>;
}

export interface ResolvedPerson {
  /** 规范化的 URL slug */
  slug: string;
  gameId: string;
  source: 'static' | 'account';
  /** 静态人物才有 */
  personId?: string;
}

/**
 * slug → 人物。静态人物 entry id 优先（保留 `/people/nz-173/`），
 * 其次匹配账号 username（忽略大小写）。都没有返回 null。
 */
export const resolvePersonBySlug = async (
  slug: string,
  lookup: SlugLookup
): Promise<ResolvedPerson | null> => {
  const value = typeof slug === 'string' ? slug.trim() : '';
  if (!value) return null;

  const person = lookup.staticPeople.find((entry) => entry.id === value);
  if (person) {
    return { slug: person.id, gameId: person.gameId, source: 'static', personId: person.id };
  }

  const account = await lookup.findAccount(value);
  if (!account?.username) return null;
  return { slug: account.username.toLowerCase(), gameId: account.username, source: 'account' };
};

export interface MigrationResult {
  /** 传记键是否真的改了名 */
  migrated: boolean;
  /** 同步了多少条评论的 authorUsername/authorGameId */
  commentsUpdated: number;
}

/**
 * 账号 username 变更后迁移传记键，并把所有评论里的旧作者信息改成新用户名。
 * 目标键已有别的传记时不动传记（避免重复键），但仍然同步评论。
 *
 * comments.game_id 外键指向 biographies.game_id；改名时把该传记下的评论
 * 一起搬到新键。用 defer_foreign_keys 延迟外键检查到 COMMIT，父键和子键
 * 才能在同一个事务里互换而不触发立即校验。
 */
export const migrateBiographyOwner = async (
  oldUsername: string,
  newUsername: string
): Promise<MigrationResult> => {
  const oldName = typeof oldUsername === 'string' ? oldUsername.trim() : '';
  const newName = typeof newUsername === 'string' ? newUsername.trim() : '';
  if (!oldName || !newName) return { migrated: false, commentsUpdated: 0 };

  return withTransaction((): MigrationResult => {
    const db = getDb();
    const now = new Date().toISOString();
    const oldKey = oldName.toLowerCase();
    const newKey = newName.toLowerCase();
    let migrated = false;

    if (oldKey !== newKey) {
      const source = findRow(db, oldName);
      const target = findRow(db, newName);
      if (source && (!target || target.game_id === source.game_id)) {
        db.exec('PRAGMA defer_foreign_keys = ON');

        const oldDefaultTitle = defaultMainTitle(source.game_id);
        // 默认标题里带着游戏 ID；账号改名后要同步，不然会留下旧 ID。
        // 自定义标题属于作者内容，保持原样。
        const nextTitle =
          source.main_title === oldDefaultTitle ? defaultMainTitle(newName) : source.main_title;

        db.prepare(
          'UPDATE biographies SET game_id = ?, main_title = ?, updated_at = ? WHERE game_id = ?'
        ).run(newName, nextTitle, now, source.game_id);
        db.prepare('UPDATE comments SET game_id = ? WHERE game_id = ?').run(
          newName,
          source.game_id
        );
        migrated = true;
      }
    }

    const affected = db
      .prepare(
        `SELECT id, author_username, author_game_id FROM comments
         WHERE author_username COLLATE NOCASE = ?
            OR author_game_id COLLATE NOCASE = ?`
      )
      .all(oldName, oldName) as Array<{
      id: string;
      author_username: string;
      author_game_id: string;
    }>;

    for (const row of affected) {
      const authorUsername =
        row.author_username.toLowerCase() === oldKey ? newName : row.author_username;
      const authorGameId =
        row.author_game_id.toLowerCase() === oldKey ? newName : row.author_game_id;
      db.prepare('UPDATE comments SET author_username = ?, author_game_id = ? WHERE id = ?').run(
        authorUsername,
        authorGameId,
        row.id
      );
    }

    return { migrated, commentsUpdated: affected.length };
  });
};