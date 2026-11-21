import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getPendingIssues } from './routes/admin.ts';
import { login, logout, me, register } from './routes/auth.ts';
import { getAvatar } from './routes/avatar.ts';
import { getGateCodes } from './routes/gate.ts';
import { health } from './routes/health.ts';
import {
  createIssue,
  createReply,
  getIssueById,
  listIssues,
  listReplies,
  patchIssueById,
} from './routes/issues.ts';
import {
  createComment,
  getBiography,
  getComments,
  getPerson,
  listPeople,
  removeComment,
  saveBiography,
} from './routes/people.ts';
import { pluginLoginVerify } from './routes/plugin.ts';
import { createLauncherRoutes } from './routes/launcher.ts';
import { getStatus } from './routes/status.ts';

/**
 * 组装 Hono 应用。测试与 `server.ts` 共用这一处，避免路由散落在启动文件里。
 *
 * 所有 API 路由都由 `src/http/handler.ts` 的适配层包装，原 Astro handler 主体
 * 不感知 Hono。请求体全局上限 1MiB；超限返回 JSON 413，而不是 Hono 默认的
 * 纯文本 HTTPException，调用方（插件 / 启动器）只需要处理一种错误形状。
 */
export const createApp = (): Hono => {
  const app = new Hono();

  // 启动器路由先于全局 bodyLimit 注册：normalize 需要 2MiB，自己带 bodyLimit；
  // 既有路由仍走下面的 1MiB 上限（Hono 按注册顺序短路，不会串用）。
  app.route('/api/launcher', createLauncherRoutes());

  app.use(
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: '请求体太大' }, 413),
    })
  );

  app.get('/api/health', health);

  app.post('/api/auth/register', register);
  app.post('/api/auth/login', login);
  app.post('/api/auth/logout', logout);
  app.get('/api/auth/me', me);

  app.post('/api/plugin/login/verify', pluginLoginVerify);

  app.get('/api/gate/codes', getGateCodes);
  app.get('/api/status', getStatus);
  app.get('/api/avatar/:name', getAvatar);

  app.get('/api/issues', listIssues);
  app.post('/api/issues', createIssue);
  app.get('/api/issues/:id', getIssueById);
  app.patch('/api/issues/:id', patchIssueById);
  app.get('/api/issues/:id/replies', listReplies);
  app.post('/api/issues/:id/replies', createReply);

  app.get('/api/admin/pending', getPendingIssues);

  app.get('/api/people', listPeople);
  app.get('/api/people/:id', getPerson);
  app.get('/api/people/:id/biography', getBiography);
  app.put('/api/people/:id/biography', saveBiography);
  app.get('/api/people/:id/comments', getComments);
  app.post('/api/people/:id/comments', createComment);
  app.delete('/api/people/:id/comments/:cid', removeComment);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((error, c) => {
    console.error('[hydwind-api] unhandled error', error);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
};