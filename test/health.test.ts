import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';

test('GET /api/health 返回插件契约所需的 ok 与 uptime', async () => {
  const response = await createApp().request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = (await response.json()) as { ok?: unknown; uptime?: unknown };
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptime, 'number');
  assert.ok((body.uptime as number) >= 0);
});

test('未知路径返回 JSON 404', async () => {
  const response = await createApp().request('/api/nope');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});