import { getSite } from '../domain/content.ts';
import { fetchServerStatus } from '../domain/server-status.ts';
import { handle } from '../http/handler.ts';

/**
 * GET /api/status → 当前服务器在线状态。
 *
 * 形状与 hydwind-web 的 `src/pages/api/status.ts` 一致：状态字段之外补 host /
 * port，避免前端为两个短字段再读一次站点信息。第三方数据源有 60 秒缓存，
 * 响应也允许 CDN 缓存同样时长。
 */
export const getStatus = handle(async () => {
  const site = await getSite();
  const status = await fetchServerStatus(site.address);

  return new Response(
    JSON.stringify({
      ...status,
      host: site.host,
      port: site.port,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=30, s-maxage=60',
      },
    }
  );
});