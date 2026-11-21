import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  gameIdForSlug,
  isSameOrigin,
  presentComment,
} from '../src/domain/comments.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'content');

const request = (url: string, origin?: string): Request =>
  new Request(url, { headers: origin === undefined ? {} : { origin } });

const withEnv = async <T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T> | T
): Promise<T> => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('isSameOrigin: 没有 Origin 头视为同源', () => {
  assert.equal(isSameOrigin(request('http://api.test/api/x')), true);
});

test('isSameOrigin: 显式 expectedOrigin 与 Origin 相同才放行', () => {
  assert.equal(
    isSameOrigin(request('http://127.0.0.1:8787/api/x', 'https://hydwind.example'), 'https://hydwind.example'),
    true
  );
  assert.equal(
    isSameOrigin(request('http://127.0.0.1:8787/api/x', 'https://evil.example'), 'https://hydwind.example'),
    false
  );
});

test('isSameOrigin: 未传 expectedOrigin 时使用 PUBLIC_ORIGIN', async () => {
  await withEnv({ PUBLIC_ORIGIN: 'https://hydwind.example' }, () => {
    assert.equal(
      isSameOrigin(request('http://127.0.0.1:8787/api/x', 'https://hydwind.example')),
      true
    );
    assert.equal(
      isSameOrigin(request('http://127.0.0.1:8787/api/x', 'https://evil.example')),
      false
    );
  });
});

test('isSameOrigin: expectedOrigin 参数优先于 PUBLIC_ORIGIN', async () => {
  await withEnv({ PUBLIC_ORIGIN: 'https://from-env.example' }, () => {
    assert.equal(
      isSameOrigin(
        request('http://127.0.0.1:8787/api/x', 'https://from-param.example'),
        'https://from-param.example'
      ),
      true
    );
    assert.equal(
      isSameOrigin(
        request('http://127.0.0.1:8787/api/x', 'https://from-param.example'),
        'https://from-env.example'
      ),
      false
    );
  });
});

test('isSameOrigin: 两者都没给时退回 request.url', async () => {
  await withEnv({ PUBLIC_ORIGIN: undefined }, () => {
    assert.equal(
      isSameOrigin(request('http://api.test/api/x', 'http://api.test')),
      true
    );
    assert.equal(
      isSameOrigin(request('http://api.test/api/x', 'http://other.test')),
      false
    );
  });
});

test('isSameOrigin: 非法 Origin / expectedOrigin 返回 false', async () => {
  assert.equal(isSameOrigin(request('http://api.test/api/x', 'not a url')), false);

  await withEnv({ PUBLIC_ORIGIN: undefined }, () => {
    assert.equal(
      isSameOrigin(request('http://api.test/api/x', 'http://api.test'), '::::'),
      false
    );
  });
});

test('isSameOrigin: 比较 origin，scheme 不同也算跨源', () => {
  assert.equal(
    isSameOrigin(request('http://api.test/api/x', 'http://api.test'), 'https://api.test'),
    false
  );
});

test('gameIdForSlug 解析静态人物 id，未知 slug 返回 null', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hydwind-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await withEnv(
    {
      HYDWIND_CONTENT_DIR: FIXTURES,
      HYDWIND_DATA_DIR: dataDir,
      HYDWIND_DB_PATH: ':memory:',
      PUBLIC_ORIGIN: undefined,
    },
    async () => {
      assert.equal(await gameIdForSlug('nz-173'), 'Nz_173');
      assert.equal(await gameIdForSlug('  nz-173  '), 'Nz_173');
      assert.equal(await gameIdForSlug('__hydwind_missing_person__'), null);
    }
  );
});

test('presentComment 只输出展示字段，没有账号时回退到游戏 ID', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hydwind-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await withEnv({ HYDWIND_DATA_DIR: dataDir, HYDWIND_DB_PATH: ':memory:' }, async () => {
    const presented = await presentComment({
      id: 'comment-1',
      authorUsername: '__hydwind_missing_author__',
      authorGameId: 'Miss_ing',
      body: '你好，氢风。',
      createdAt: '2026-11-21T00:00:00.000Z',
    });

    assert.deepEqual(presented, {
      id: 'comment-1',
      authorGameId: 'Miss_ing',
      authorDisplay: 'Miss_ing',
      body: '你好，氢风。',
      createdAt: '2026-11-21T00:00:00.000Z',
    });
    assert.equal('authorUsername' in presented, false);
  });
});