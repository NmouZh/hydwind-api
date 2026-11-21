import { consumeRateLimit } from '../domain/rate-limit.ts';
import {
  addIssueReply,
  createIssue as insertIssue,
  getIssue,
  isIssueStatus,
  listIssues as loadIssues,
  updateIssueStatus,
  validateNewIssue,
} from '../domain/issues.ts';
import type { NewIssueInput } from '../domain/issues.ts';
import { json } from '../http/api-response.ts';
import { isStaffRequest } from '../http/auth.ts';
import { handle } from '../http/handler.ts';

/**
 * 议题接口。
 *
 * 鉴权、字段与错误码沿用 hydwind-web：
 * - 写接口（改状态 / 回复）只认站务令牌或 admin 会话；
 * - 站内提交进 pending，公开列表自动过滤，站务可见；
 * - 列表按 id 降序、回复按 id 升序由存储层保证。
 */

const ISSUE_WINDOW_MS = 10 * 60_000;
const ISSUE_SUBMIT_LIMIT = 5;

const requireStaff = async (request: Request): Promise<Response | null> =>
  (await isStaffRequest(request)) ? null : json({ error: '需要站务权限' }, 401);

const parseId = (raw: string | undefined): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** GET /api/issues —— 匿名只看公开议题，站务额外拿到 pending。 */
export const listIssues = handle(async (request) => {
  const staff = await isStaffRequest(request);
  const issues = await loadIssues({ includePending: staff });

  return json({
    issues: issues.map(({ id, title, author, category, status, createdAt, updatedAt, replies }) => ({
      id,
      title,
      author,
      category,
      status,
      createdAt,
      updatedAt,
      replyCount: replies.length,
    })),
  });
});

/** POST /api/issues → 提交新议题，进入 pending 待审队列。 */
export const createIssue = handle(async (request, ctx) => {
  const limit = consumeRateLimit(
    `issue:${ctx.clientAddress}`,
    ISSUE_SUBMIT_LIMIT,
    ISSUE_WINDOW_MS
  );
  if (!limit.ok) {
    return json({ error: '提交太频繁啦，休息几分钟再试' }, 429);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  // 合法 JSON 但不是对象时按空表单处理，交给 validateNewIssue 给出 422。
  const parsed = validateNewIssue(
    (payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {}) as NewIssueInput
  );
  if (!parsed.ok) return json({ error: parsed.message }, 422);

  const issue = await insertIssue(parsed.value);
  return json(
    {
      issue: {
        id: issue.id,
        title: issue.title,
        status: issue.status,
        createdAt: issue.createdAt,
      },
      message: '提交成功，通过审核后会公开在议题列表里',
    },
    201
  );
});

/** GET /api/issues/:id —— 待审议题对外不可见，避免未审核内容被直接访问。 */
export const getIssueById = handle(async (request, ctx) => {
  const id = parseId(ctx.params.id);
  if (id === null) return json({ error: '议题编号不合法' }, 400);

  const issue = await getIssue(id);
  if (!issue || (issue.status === 'pending' && !(await isStaffRequest(request)))) {
    return json({ error: '议题不存在' }, 404);
  }
  return json({ issue });
});

/** PATCH /api/issues/:id { status } —— 站务改状态（通过 / 驳回 / 完成）。 */
export const patchIssueById = handle(async (request, ctx) => {
  const denied = await requireStaff(request);
  if (denied) return denied;

  const id = parseId(ctx.params.id);
  if (id === null) return json({ error: '议题编号不合法' }, 400);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const status = (payload as { status?: unknown } | null)?.status;
  if (!isIssueStatus(status)) {
    return json({ error: '状态必须是 pending / open / rejected / done' }, 422);
  }

  const issue = await updateIssueStatus(id, status);
  if (!issue) return json({ error: '议题不存在' }, 404);
  return json({ issue });
});

/** GET /api/issues/:id/replies —— 待审议题的回复同样不公开。 */
export const listReplies = handle(async (request, ctx) => {
  const id = parseId(ctx.params.id);
  if (id === null) return json({ error: '议题编号不合法' }, 400);

  const issue = await getIssue(id);
  if (!issue) return json({ error: '议题不存在' }, 404);
  if (issue.status === 'pending' && !(await isStaffRequest(request))) {
    return json({ error: '议题不存在' }, 404);
  }
  return json({ replies: issue.replies });
});

/** POST /api/issues/:id/replies —— 站务回复，插件同步群内进展也走这里。 */
export const createReply = handle(async (request, ctx) => {
  const denied = await requireStaff(request);
  if (denied) return denied;

  const id = parseId(ctx.params.id);
  if (id === null) return json({ error: '议题编号不合法' }, 400);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const fields = payload as { body?: unknown; author?: unknown } | null;
  const body = String(fields?.body ?? '').trim();
  const author = String(fields?.author ?? '氢风站务').trim().slice(0, 32);
  if (body.length < 1 || body.length > 1000) {
    return json({ error: '回复内容需要在 1–1000 字之间' }, 422);
  }

  const issue = await addIssueReply(id, { author: author || '氢风站务', body, staff: true });
  if (!issue) return json({ error: '议题不存在' }, 404);
  return json({ issue }, 201);
});