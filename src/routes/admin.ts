import { listIssues } from '../domain/issues.ts';
import { json } from '../http/api-response.ts';
import { requireAdmin } from '../http/auth.ts';
import { handle } from '../http/handler.ts';

/**
 * GET /api/admin/pending —— 给 AstrBot 插件轮询用。
 *
 * 只认站务令牌（ISSUE_ADMIN_TOKEN），不认浏览器会话：插件在群外轮询，
 * 不该依赖某个人的登录态。
 */
export const getPendingIssues = handle(async (request) => {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const issues = await listIssues({ includePending: true });
  return json({ pending: issues.filter((issue) => issue.status === 'pending') });
});