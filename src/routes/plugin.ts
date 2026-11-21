import type { Account } from '../domain/accounts.ts';
import { findAccount } from '../domain/accounts.ts';
import { ensureBiographyForAccount } from '../domain/biographies.ts';
import { verifyLoginCode } from '../domain/login-codes.ts';
import { isJson, json, readJsonObject } from '../http/api-response.ts';
import { handle } from '../http/handler.ts';
import { requirePlugin } from '../http/plugin-auth.ts';

/**
 * HydwindGate 插件的登录码校验。
 *
 * 契约见 hydwind-web/docs/backend-api.md：
 *   Authorization: Bearer <PLUGIN_TOKEN>
 *   { code, gameId, uuid }
 *   → 200 { ok: true, account: { username, nickname, role } }
 *   → 401 令牌错误
 *   → 409 { ok: false, reason: invalid_code|expired|used|game_id_mismatch, expectedGameId? }
 *   → 429 { ok: false, reason: 'rate_limited', retryAfterMs, attemptsRemaining }
 *
 * 只接受 PLUGIN_TOKEN：站务令牌和浏览器会话都不能调这个接口。账号存在性与
 * gameId 匹配放在 beforeConsume 里，失败时不烧掉码。
 */

const MAX_BODY_BYTES = 1024;
const MAX_CODE_LENGTH = 128;
const MAX_GAME_ID_LENGTH = 64;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidRequest = (reason: string, status: number): Response =>
  json({ ok: false, reason }, status);

const conflict = (
  reason: 'invalid_code' | 'expired' | 'used' | 'game_id_mismatch',
  expectedGameId?: string
): Response =>
  json(expectedGameId ? { ok: false, reason, expectedGameId } : { ok: false, reason }, 409);

export const pluginLoginVerify = handle(async (request) => {
  const denied = requirePlugin(request);
  if (denied) return denied;

  if (!isJson(request)) return invalidRequest('unsupported_media_type', 415);

  // 共用读取器负责 1KB 上限与 JSON 对象校验；错误形状映射回插件契约的
  // reason，避免把 Web 侧的中文错误文案泄露给插件。
  const parsed = await readJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    const tooLarge = parsed.response.status === 413;
    return invalidRequest(tooLarge ? 'payload_too_large' : 'bad_request', tooLarge ? 413 : 400);
  }

  const fields = parsed.value;
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  const gameId = typeof fields.gameId === 'string' ? fields.gameId.trim() : '';
  const uuid = typeof fields.uuid === 'string' ? fields.uuid.trim() : '';

  if (
    !code ||
    !gameId ||
    code.length > MAX_CODE_LENGTH ||
    gameId.length > MAX_GAME_ID_LENGTH ||
    !UUID_PATTERN.test(uuid)
  ) {
    return invalidRequest('bad_request', 400);
  }

  // verifyLoginCode 的回调赋值不被 TS 的控制流分析追踪，读取时显式收窄。
  let matchedAccount: Account | null = null;

  const result = await verifyLoginCode(
    { code, gameId },
    {
      beforeConsume: async (record) => {
        const account = await findAccount(record.username);
        if (!account) return { reason: 'invalid_code' };
        if (account.username.toLowerCase() !== gameId.toLowerCase()) {
          return { reason: 'game_id_mismatch', expectedGameId: account.username };
        }
        matchedAccount = account;
        return true;
      },
    }
  );

  if (!result.ok) {
    const { reason } = result;
    if (reason === 'rate_limited') {
      const retryAfterMs = result.retryAfterMs ?? 0;
      return json(
        {
          ok: false,
          reason,
          retryAfterMs,
          attemptsRemaining: result.attemptsRemaining ?? 0,
        },
        429,
        { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
      );
    }
    return conflict(reason, result.expectedGameId);
  }

  const account = matchedAccount as Account | null;
  if (!account) return conflict('invalid_code');

  console.info(`[plugin-login] verified username=${account.username} uuid=${uuid}`);

  try {
    await ensureBiographyForAccount(account);
  } catch (error) {
    // 传记创建失败不该阻断进服；账号本身已经验证成功。
    console.error(`[plugin-login] biography creation failed username=${account.username}`, error);
  }

  return json({
    ok: true,
    account: {
      username: account.username,
      nickname: account.nickname,
      role: account.role,
    },
  });
});