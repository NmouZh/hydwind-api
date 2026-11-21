import type { StaticPersonRef } from './biographies.ts';
import { getPublishedPeople } from './content.ts';

/**
 * 运行时视角的 curated 人物列表。
 *
 * 原来 Web 端在 `src/lib/static-people.ts` 里直接读 `src/content/people`；
 * 独立后端统一走 content.ts，只暴露 slug 解析需要的 id/gameId。
 */
export const loadStaticPeople = async (): Promise<StaticPersonRef[]> => {
  const people = await getPublishedPeople();
  return people.map((person) => ({
    id: person.id,
    gameId: person.data.gameId,
  }));
};