import {
  findAccount,
  normalizeUsername,
  publicAccount,
  registerAccount,
  verifyLogin,
} from '../domain/accounts.ts';
import { ensureBiographyForAccount } from '../domain/biographies.ts';
import { isSameOrigin } from '../domain/comments.ts';
import { consumeRateLimit } from '../domain/rate-limit.ts';
import { isJson, json, readJsonObject } from '../http/api-response.ts';
import { requireAdmin } from '../http/auth.ts';
import { handle, isSecureRequest } from '../http/handler.ts';
import { clearSessionCookie, createSessionCookie, readSession } from '../http/session.ts';

/**
 * 账号接口。
 *
 * 与原 hydwind-web 的 `src/pages/api/auth/*` 保持同一套契约：
 * - 注册只对站务令牌开放，插件在群里代玩家建号；
 * - 登录失败不区分「账号不存在」和「密码错误」；
 * - 会话 cookie 的格式仍由 `http/session.ts` 决定，旧登录态继续有效。
 */

const REGISTER_MAX_BODY_BYTES = 4 * 1024;

const LOGIN_MAX_BODY_BYTES = 1024;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_IP_LIMIT = 10;
const LOGIN_USER_LIMIT = 5;

const tooMany = (retryAfterMs: number): Response =>
  json({ error: '尝试太多次了，过几分钟再来' }, 429, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });

/**
 * POST /api/auth/register
 *
 * body: { username, platformId, platform?, nickname?, password?, role? }
 * resp: { username, password, role, created }
 *
 * 新账号在这里顺手建好默认传记；失败只记日志，不影响把账号密码回给玩家。
 */
export const register = handle(async (request) => {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const limit = consumeRateLimit('register', 60, 10 * 60_000);
  if (!limit.ok) return json({ error: '注册太频繁啦，稍后再试' }, 429);

  const parsed = await readJsonObject(request, REGISTER_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const result = await registerAccount({
    username: parsed.value.username,
    platformId: parsed.value.platformId,
    platform: parsed.value.platform,
    nickname: parsed.value.nickname,
    password: parsed.value.password,
    role: parsed.value.role,
  });

  if (!result.ok) return json({ error: result.message }, 400);

  try {
    await ensureBiographyForAccount({ username: result.value.username });
  } catch (error) {
    console.error(`[auth] biography creation failed username=${result.value.username}`, error);
  }

  return json(result.value);
});

/**
 * POST /api/auth/login  body: { username, password }
 *
 * 限定同源、请求体 1KB、IP 与账号双维度限流；账号比对交给 accounts.ts。
 */
export const login = handle(async (request, ctx) => {
  if (!isSameOrigin(request, ctx.origin)) return json({ error: '请求来源不对' }, 403);
  if (!isJson(request)) return json({ error: '请求体必须是 JSON' }, 415);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > LOGIN_MAX_BODY_BYTES) {
    return json({ error: '请求体太大' }, 413);
  }

  const ipLimit = consumeRateLimit(
    `login:ip:${ctx.clientAddress}`,
    LOGIN_IP_LIMIT,
    LOGIN_WINDOW_MS
  );
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterMs);

  const raw = await request.text();
  if (raw.length > LOGIN_MAX_BODY_BYTES) return json({ error: '请求体太大' }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: '请求体格式不对' }, 400);
  }

  const fields = payload as Record<string, unknown>;
  const username = typeof fields.username === 'string' ? fields.username.trim() : '';
  const password = typeof fields.password === 'string' ? fields.password : '';

  if (!username || !password) return json({ error: '账号和密码都要填' }, 400);
  if (username.length > 64 || password.length > 200) {
    return json({ error: '账号或密码太长' }, 400);
  }

  // 归一化之后再按账号计数，避免 Nz / nz / nZ 各刷一份额度
  const accountKey = normalizeUsername(username).toLowerCase() || username.toLowerCase();
  const userLimit = consumeRateLimit(
    `login:user:${accountKey}`,
    LOGIN_USER_LIMIT,
    LOGIN_WINDOW_MS
  );
  if (!userLimit.ok) return tooMany(userLimit.retryAfterMs);

  const account = await verifyLogin(username, password);
  if (!account) return json({ error: '账号或密码不对' }, 401);

  createSessionCookie(
    ctx.cookies,
    account.username,
    account.role,
    isSecureRequest(request)
  );
  return json({ account: publicAccount(account) });
});

/** POST /api/auth/logout —— 清掉会话 cookie。 */
export const logout = handle(async (_request, ctx) => {
  clearSessionCookie(ctx.cookies);
  return json({ ok: true });
});

/**
 * GET /api/auth/me —— 当前登录账号。
 *
 * cookie 里的 role 只在签名时可信，账号可能已经降权或删除；这里一律回查。
 */
export const me = handle(async (_request, ctx) => {
  const session = readSession(ctx.cookies);
  if (!session) return json({ error: '未登录' }, 401);

  const account = await findAccount(session.username);
  if (!account) return json({ error: '账号已不存在' }, 401);

  return json({ account: publicAccount(account) });
});