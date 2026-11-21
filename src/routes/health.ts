import type { Context } from 'hono';

/** GET /api/health：HydwindGate 插件用于健康检查与受控重启。 */
export const health = (c: Context): Response =>
  c.json({ ok: true, uptime: Math.floor(process.uptime()) }, 200, {
    'cache-control': 'no-store',
  });