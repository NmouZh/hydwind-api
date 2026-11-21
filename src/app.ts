import { Hono } from 'hono';
import { health } from './routes/health.ts';

/**
 * 组装 Hono 应用。测试与 `server.ts` 共用这一处，避免路由在启动文件里。
 *
 * 后续迁移的 Astro handler 会通过 `src/http/handler.ts` 的适配层挂到这里。
 */
export const createApp = (): Hono => {
  const app = new Hono();

  app.get('/api/health', health);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((error, c) => {
    console.error('[hydwind-api] unhandled error', error);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
};