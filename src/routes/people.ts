import { findAccount, listAccounts } from '../domain/accounts.ts';
import type { Account } from '../domain/accounts.ts';
import {
  addComment,
  canEditBiography,
  defaultMainTitle,
  deleteComment,
  ensureBiographyForAccount,
  findBiographyByGameId,
  listComments,
  listGameBiographies,
  resolvePersonBySlug,
  updateBiography,
} from '../domain/biographies.ts';
import type { Biography, EditAccount, ResolvedPerson } from '../domain/biographies.ts';
import {
  gameIdForSlug,
  isSameOrigin,
  presentComment,
} from '../domain/comments.ts';
import { getPublishedPeople } from '../domain/content.ts';
import {
  buildPeopleList,
  filterPeopleList,
} from '../domain/people-list.ts';
import type { StaticPersonInput } from '../domain/people-list.ts';
import { canDeleteCommentForAuthor } from '../domain/person-page.ts';
import { consumeRateLimit } from '../domain/rate-limit.ts';
import { loadStaticPeople } from '../domain/static-people.ts';
import { isJson, json, readJsonObject } from '../http/api-response.ts';
import { handle } from '../http/handler.ts';
import { readSession } from '../http/session.ts';

/**
 * 人物、传记与评论接口。
 *
 * 这一组沿用 hydwind-web 的 slug 语义：静态人物 entry id 优先
 * （`/people/nz-173/` 保持不变），其次匹配账号 username（忽略大小写）。
 * 传记按账号 gameId 存，一个玩家一篇；评论从属于传记。
 *
 * 新增的 `GET /api/people` 与 `GET /api/people/:id` 给 Web SSR 和启动器复用，
 * 把列表合并、详情聚合和「谁能编辑 / 删除」的判断都收在服务端。
 */

const BIO_MAX_BODY_BYTES = 64 * 1024;
const BIO_SAVE_WINDOW_MS = 10 * 60_000;
const BIO_SAVE_LIMIT = 12;

const COMMENT_MAX_BODY_BYTES = 2048;

const resolveSlug = async (slug: string): Promise<ResolvedPerson | null> =>
  resolvePersonBySlug(slug, {
    staticPeople: await loadStaticPeople(),
    findAccount,
  });

const viewerOf = async (
  cookies: Parameters<typeof readSession>[0]
): Promise<Account | null> => {
  const session = readSession(cookies);
  if (!session) return null;
  return (await findAccount(session.username)) ?? null;
};

const biographyFields = (biography: Biography) => ({
  gameId: biography.gameId,
  mainTitle: biography.mainTitle,
  body: biography.body,
  createdAt: biography.createdAt,
  updatedAt: biography.updatedAt,
});

const personFields = (resolved: ResolvedPerson) =>
  resolved.personId
    ? {
        slug: resolved.slug,
        gameId: resolved.gameId,
        source: resolved.source,
        personId: resolved.personId,
      }
    : {
        slug: resolved.slug,
        gameId: resolved.gameId,
        source: resolved.source,
      };

/**
 * GET /api/people?q= —— 静态 curated 人物与注册账号合并后的列表。
 *
 * q 只搜索 gameId 与昵称（忽略大小写与首尾空白），与 Web 列表页一致。
 */
export const listPeople = handle(async (request) => {
  const [people, accounts, biographies] = await Promise.all([
    getPublishedPeople(),
    listAccounts(),
    listGameBiographies(),
  ]);

  const staticPeople: StaticPersonInput[] = people.map((person) => ({
    id: person.id,
    gameId: person.data.gameId,
    role: person.data.role,
    tags: person.data.tags,
    avatar: person.data.avatar,
    updated: person.data.updated,
    hasBody: Boolean(person.body?.trim()),
  }));

  const allItems = buildPeopleList({ staticPeople, accounts, biographies });
  const items = filterPeopleList(
    allItems,
    new URL(request.url).searchParams.get('q')
  );
  return json({ people: items });
});

/**
 * GET /api/people/:id —— 聚合人物详情。
 *
 * - `person.source=account` 时确保运行期传记存在（账号注册后始终有一篇）；
 * - `person.source=static` 且没有运行期传记时 `biography` 为 null，静态正文
 *   由 Web 自己从内容集合渲染；
 * - 评论的 `canDelete` 用存储层的 authorUsername 精确判断，不能只看
 *   authorGameId（改名迁移后两者可能不同）。
 */
export const getPerson = handle(async (_request, ctx) => {
  const resolved = await resolveSlug(ctx.params.id ?? '');
  if (!resolved) return json({ error: '没有这个人物' }, 404);

  const viewer = await viewerOf(ctx.cookies);
  const canEdit = canEditBiography(viewer as EditAccount | null, resolved.gameId);

  const biography =
    resolved.source === 'account'
      ? await ensureBiographyForAccount({ username: resolved.gameId })
      : await findBiographyByGameId(resolved.gameId);

  const comments = await listComments(resolved.gameId);
  const presented = await Promise.all(
    comments.map(async (comment) => ({
      ...(await presentComment(comment)),
      canDelete: canDeleteCommentForAuthor(comment.authorUsername, viewer),
    }))
  );

  return json({
    person: personFields(resolved),
    biography: biography ? biographyFields(biography) : null,
    comments: presented,
    viewer: viewer
      ? { username: viewer.username, nickname: viewer.nickname, role: viewer.role }
      : null,
    canEdit,
  });
});

/** GET /api/people/:id/biography —— 公开读取；合法人物没写过时返回默认空传记。 */
export const getBiography = handle(async (_request, ctx) => {
  const resolved = await resolveSlug(ctx.params.id ?? '');
  if (!resolved) return json({ error: '没有这个人物' }, 404);

  const biography = await findBiographyByGameId(resolved.gameId);
  const viewer = await viewerOf(ctx.cookies);

  return json({
    gameId: resolved.gameId,
    mainTitle: biography?.mainTitle ?? defaultMainTitle(resolved.gameId),
    body: biography?.body ?? '',
    canEdit: canEditBiography(viewer as EditAccount | null, resolved.gameId),
    updatedAt: biography?.updatedAt ?? null,
  });
});

/** PUT /api/people/:id/biography —— 仅本人或管理员，10 分钟 12 次。 */
export const saveBiography = handle(async (request, ctx) => {
  if (!isJson(request)) return json({ error: '请求体必须是 JSON' }, 415);

  const session = readSession(ctx.cookies);
  if (!session) return json({ error: '先登录再写传记' }, 401);

  const account = await findAccount(session.username);
  if (!account) return json({ error: '账号已不存在，请重新登录' }, 401);

  if (!isSameOrigin(request, ctx.origin)) return json({ error: '请求来源不对' }, 403);

  const resolved = await resolveSlug(ctx.params.id ?? '');
  if (!resolved) return json({ error: '没有这个人物' }, 404);

  // 权限只看「账号 ↔ 目标 gameId」，和传记是否已存在无关：
  // 这样普通登录用户不能抢着创建别人的第一篇。
  if (!canEditBiography(account, resolved.gameId)) {
    return json({ error: '只能编辑自己的传记' }, 403);
  }

  const parsed = await readJsonObject(request, BIO_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const limit = consumeRateLimit(
    `bio:${account.username.toLowerCase()}:${ctx.clientAddress}`,
    BIO_SAVE_LIMIT,
    BIO_SAVE_WINDOW_MS
  );
  if (!limit.ok) {
    return json({ error: '保存太频繁啦，过几分钟再试' }, 429, {
      'retry-after': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
    });
  }

  const saved = await updateBiography(resolved.gameId, {
    mainTitle: parsed.value.mainTitle,
    body: parsed.value.body,
  });
  if (!saved.ok) return json({ error: saved.message }, 400);

  // PUT 的响应字段与原 Web 保持一致（不含 createdAt）；createdAt 只在
  // 新增的人物详情聚合接口里返回。
  return json({
    gameId: saved.value.gameId,
    mainTitle: saved.value.mainTitle,
    body: saved.value.body,
    canEdit: true,
    updatedAt: saved.value.updatedAt,
    message: '传记保存好了',
  });
});

/** GET /api/people/:id/comments —— 公开读取评论，按创建时间正序。 */
export const getComments = handle(async (_request, ctx) => {
  const gameId = await gameIdForSlug(ctx.params.id ?? '');
  if (!gameId) return json({ error: '没有这个人物' }, 404);

  const comments = await listComments(gameId);
  return json({ comments: await Promise.all(comments.map(presentComment)) });
});

/** POST /api/people/:id/comments —— 登录玩家发评论，每账号 10 分钟 5 条。 */
export const createComment = handle(async (request, ctx) => {
  const session = readSession(ctx.cookies);
  if (!session) return json({ error: '先登录再发表评论' }, 401);

  const account = await findAccount(session.username);
  if (!account) return json({ error: '账号已不存在，请重新登录' }, 401);

  if (!isSameOrigin(request, ctx.origin)) return json({ error: '请求来源不对' }, 403);

  const gameId = await gameIdForSlug(ctx.params.id ?? '');
  if (!gameId) return json({ error: '没有这个人物' }, 404);

  if (!isJson(request)) return json({ error: '请求体必须是 JSON' }, 415);

  const parsed = await readJsonObject(request, COMMENT_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  // 静态人物或账号可能还没有运行期传记记录；评论挂在传记上，先 ensure 一份。
  await ensureBiographyForAccount({ username: gameId });

  const result = await addComment(gameId, { username: account.username }, parsed.value.body);
  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      return json({ error: result.message }, 429, {
        'retry-after': String(
          Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000))
        ),
      });
    }
    return json({ error: result.message }, result.reason === 'not_found' ? 404 : 400);
  }

  return json({ comment: await presentComment(result.value) }, 201);
});

/** DELETE /api/people/:id/comments/:cid —— 评论作者本人或管理员。 */
export const removeComment = handle(async (request, ctx) => {
  const session = readSession(ctx.cookies);
  if (!session) return json({ error: '先登录再删除评论' }, 401);

  const account = await findAccount(session.username);
  if (!account) return json({ error: '账号已不存在，请重新登录' }, 401);

  if (!isSameOrigin(request, ctx.origin)) return json({ error: '请求来源不对' }, 403);

  const gameId = await gameIdForSlug(ctx.params.id ?? '');
  const commentId = ctx.params.cid;
  if (!gameId || !commentId) return json({ error: '没有找到这条评论' }, 404);

  const result = await deleteComment(gameId, commentId, account);
  if (!result.ok) {
    return json(
      { error: result.message },
      result.reason === 'forbidden' ? 403 : 404
    );
  }
  return json({ deleted: true });
});