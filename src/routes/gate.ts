import { findAccount } from '../domain/accounts.ts';
import { isSameOrigin } from '../domain/comments.ts';
import {
  generateLoginCodes,
  LOGIN_CODE_TTL_MS,
} from '../domain/login-codes.ts';
import { consumeRateLimit } from '../domain/rate-limit.ts';
import { json } from '../http/api-response.ts';
import { handle } from '../http/handler.ts';
import { readSession } from '../http/session.ts';

/**
 * GET /api/gate/codes —— 为当前登录账号生成一组进服登录码。
 *
 * 原 `/gate/` 页面在 SSR 时直接调 `generateLoginCodes`；拆出后端后 Web 页面
 * 改用这个接口，启动器也可以在同一个会话下复用。
 *
 * - 必须登录，角色从账号存储回查（cookie 里的 role 不可信）；
 * - 浏览器带 Origin 时必须同源；
 * - 每账号每 IP 5 分钟最多 12 次，防止刷新页面刷满候选池；
 * - 生成失败（候选池暂时用尽等）返回 503，让调用方提示稍后重试。
 */

const GATE_WINDOW_MS = 5 * 60_000;
const GATE_LIMIT = 12;

export const getGateCodes = handle(async (request, ctx) => {
  const session = readSession(ctx.cookies);
  if (!session) return json({ error: '未登录' }, 401);

  const account = await findAccount(session.username);
  if (!account) return json({ error: '账号已不存在' }, 401);

  if (!isSameOrigin(request, ctx.origin)) return json({ error: '请求来源不对' }, 403);

  const limit = consumeRateLimit(
    `gate:${account.username}:${ctx.clientAddress}`,
    GATE_LIMIT,
    GATE_WINDOW_MS
  );
  if (!limit.ok) {
    return json({ error: '登录码生成太频繁啦，稍后再试' }, 429, {
      'retry-after': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
    });
  }

  try {
    const codes = generateLoginCodes({
      username: account.username,
      gameId: account.username,
    });
    return json({ ...codes, ttlMs: LOGIN_CODE_TTL_MS });
  } catch (error) {
    console.error(`[gate] login code generation failed username=${account.username}`, error);
    return json({ error: '登录码暂时生成不出来，请稍后重试' }, 503);
  }
});