import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { closeDb, getDb } from '../src/db/database.ts';
import {
  FALLBACK_PREFIX,
  KAOMOJI_POOL,
  LOGIN_CODE_TTL_MS,
  createMemoryLoginCodeStore,
  createSqliteLoginCodeStore,
  generateLoginCodes,
  getFallbackPrefix,
  getKaomojiPool,
  normalizeLoginCode,
  verifyLoginCode,
} from '../src/domain/login-codes.ts';
import type {
  LoginCodeOptions,
  LoginCodeStore,
  StoredLoginCode,
} from '../src/domain/login-codes.ts';

const T0 = 1_700_000_000_000;

interface Harness {
  options: LoginCodeOptions;
  advance: (ms: number) => void;
}

interface SqliteHarness extends Harness {
  store: LoginCodeStore;
}

/** 每个用例用独立 store + 可控时钟，避免进程内 Map 在用例之间串味。 */
const harness = (overrides: Partial<LoginCodeOptions> = {}): Harness => {
  let now = T0;
  const options: LoginCodeOptions = {
    store: createMemoryLoginCodeStore(),
    now: () => now,
    // 大部分用例不测限流，给足次数，让它们只验证自己的行为
    maxAttempts: 100,
    ...overrides,
  };
  return {
    options,
    advance: (ms) => {
      now += ms;
    },
  };
};

const storedRecord = (
  overrides: Partial<StoredLoginCode> & Pick<StoredLoginCode, 'id' | 'kaomoji' | 'ascii' | 'createdAt' | 'expiresAt'>
): StoredLoginCode => ({
  username: 'Alice',
  gameId: 'Alice',
  usedAt: null,
  ...overrides,
});

/** 登录码用例的环境变量覆盖；原 hydwind-web 的 test/helpers.ts 不跨仓库复用。 */
const useEnv = (t: TestContext, values: Record<string, string | undefined>): void => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const useTempDb = (t: TestContext): void => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-code-'));
  const savedDbPath = process.env.HYDWIND_DB_PATH;
  const savedDataDir = process.env.HYDWIND_DATA_DIR;

  closeDb();
  process.env.HYDWIND_DB_PATH = path.join(dir, 'hydwind.sqlite');
  delete process.env.HYDWIND_DATA_DIR;

  t.after(() => {
    closeDb();
    if (savedDbPath === undefined) delete process.env.HYDWIND_DB_PATH;
    else process.env.HYDWIND_DB_PATH = savedDbPath;
    if (savedDataDir === undefined) delete process.env.HYDWIND_DATA_DIR;
    else process.env.HYDWIND_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  });
};

const sqliteHarness = (t: TestContext, overrides: Partial<LoginCodeOptions> = {}): SqliteHarness => {
  useTempDb(t);
  let now = T0;
  const store = createSqliteLoginCodeStore();
  const options: LoginCodeOptions = {
    store,
    now: () => now,
    maxAttempts: 100,
    ...overrides,
  };
  return {
    store,
    options,
    advance: (ms) => {
      now += ms;
    },
  };
};

/* ------------------------------------------------------------------ *
 * 纯逻辑与内存 store（原 hydwind-web 断言）
 * ------------------------------------------------------------------ */

test('颜文字池有 24 个候选，全部无空格、无反引号、无 & 和 §', () => {
  assert.equal(KAOMOJI_POOL.length, 24);
  assert.equal(new Set(KAOMOJI_POOL).size, 24);

  for (const item of KAOMOJI_POOL) {
    assert.doesNotMatch(item, /\s/, `颜文字含空白：${item}`);
    assert.ok(!item.includes('`'), `颜文字含反引号：${item}`);
    assert.ok(!item.includes('&'), `颜文字含 &：${item}`);
    assert.ok(!item.includes('§'), `颜文字含 §：${item}`);
  }
});

test('随机取两个不同颜文字拼接成登录码', () => {
  const h = harness();
  const { code, expiresAt } = generateLoginCodes({ username: 'Alice' }, h.options);

  const valid = new Set<string>();
  for (const first of KAOMOJI_POOL) {
    for (const second of KAOMOJI_POOL) {
      if (first !== second) valid.add(first + second);
    }
  }

  assert.ok(valid.has(code), `登录码不是两个颜文字拼接：${code}`);
  assert.equal(expiresAt, T0 + LOGIN_CODE_TTL_MS);
});

test('ASCII 备用码是 HWG-XXXX，且不含 0/O/1/I/L 等易混字符', () => {
  const h = harness();

  for (let index = 0; index < 50; index += 1) {
    const { fallback } = generateLoginCodes({ username: `Player${index}` }, h.options);
    assert.match(fallback, /^HWG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    assert.doesNotMatch(fallback, /[01OILl]/);
  }
});

test('登录码按 NFC 归一化并去掉首尾空白', async () => {
  const h = harness();
  const { code } = generateLoginCodes({ username: 'Alice' }, h.options);

  // 分解形式（e + 组合尖音符 U+0301）应当合成为 é（U+00E9）
  assert.equal(normalizeLoginCode('  é  '), 'é');

  assert.deepEqual(
    await verifyLoginCode({ code: ` \t${code.normalize('NFD')}\n `, gameId: 'Alice' }, h.options),
    { ok: true, username: 'Alice', gameId: 'Alice' }
  );
});

test('ASCII 备用码大小写不敏感', async () => {
  const h = harness();
  const { fallback } = generateLoginCodes({ username: 'alice' }, h.options);

  assert.deepEqual(
    await verifyLoginCode({ code: ` ${fallback.toLowerCase()} `, gameId: 'ALICE' }, h.options),
    { ok: true, username: 'alice', gameId: 'alice' }
  );
});

test('登录码 5 分钟后过期', async () => {
  const h = harness();
  const early = generateLoginCodes({ username: 'Alice' }, h.options);
  const late = generateLoginCodes({ username: 'Alice' }, h.options);

  h.advance(LOGIN_CODE_TTL_MS - 1);
  assert.equal((await verifyLoginCode({ code: early.code, gameId: 'Alice' }, h.options)).ok, true);

  h.advance(1);
  assert.deepEqual(await verifyLoginCode({ code: late.code, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'expired',
  });
});

test('两个码绑定同一请求，任一验证成功后全部作废', async () => {
  const h = harness();

  const first = generateLoginCodes({ username: 'Alice' }, h.options);
  assert.equal((await verifyLoginCode({ code: first.code, gameId: 'Alice' }, h.options)).ok, true);
  assert.deepEqual(await verifyLoginCode({ code: first.code, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });
  assert.deepEqual(await verifyLoginCode({ code: first.fallback, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });

  const second = generateLoginCodes({ username: 'Alice' }, h.options);
  assert.equal((await verifyLoginCode({ code: second.fallback, gameId: 'Alice' }, h.options)).ok, true);
  assert.deepEqual(await verifyLoginCode({ code: second.code, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });
});

test('未知码返回 invalid_code', async () => {
  const h = harness();

  assert.deepEqual(await verifyLoginCode({ code: 'not-a-code', gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'invalid_code',
  });
  assert.deepEqual(await verifyLoginCode({ code: '   ', gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'invalid_code',
  });
});

test('码只能由绑定账号对应的游戏 ID 使用，并返回 expectedGameId', async () => {
  const h = harness();
  const { code } = generateLoginCodes({ username: 'Alice', gameId: 'AliceMC' }, h.options);

  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Bob' }, h.options), {
    ok: false,
    reason: 'game_id_mismatch',
    expectedGameId: 'AliceMC',
  });

  // 游戏 ID 比较不区分大小写；失败一次不应让码作废
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'alicemc' }, h.options), {
    ok: true,
    username: 'Alice',
    gameId: 'AliceMC',
  });
});

test('beforeConsume 失败时不作废登录码', async () => {
  const h = harness();
  const { code, fallback } = generateLoginCodes({ username: 'Alice' }, h.options);

  const rejected = await verifyLoginCode(
    { code, gameId: 'Alice' },
    {
      ...h.options,
      beforeConsume: (record) => {
        assert.equal(record.username, 'Alice');
        return { reason: 'invalid_code' };
      },
    }
  );

  assert.deepEqual(rejected, { ok: false, reason: 'invalid_code' });
  // 外部检查失败后，同一个码仍然可用（玩家改对游戏 ID / 账号恢复后可重试）
  assert.equal((await verifyLoginCode({ code, gameId: 'Alice' }, h.options)).ok, true);
  assert.deepEqual(await verifyLoginCode({ code: fallback, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });
});

test('beforeConsume 返回匹配错误时带上 expectedGameId', async () => {
  const h = harness();
  const { code } = generateLoginCodes({ username: 'Alice' }, h.options);

  assert.deepEqual(
    await verifyLoginCode(
      { code, gameId: 'Alice' },
      {
        ...h.options,
        beforeConsume: () => ({ reason: 'game_id_mismatch', expectedGameId: 'AliceReal' }),
      }
    ),
    { ok: false, reason: 'game_id_mismatch', expectedGameId: 'AliceReal' }
  );

  // 失败不烧码
  assert.equal((await verifyLoginCode({ code, gameId: 'Alice' }, h.options)).ok, true);
});

test('同一游戏 ID 在 5 分钟内最多尝试 5 次，429 带 retryAfterMs 与 attemptsRemaining', async () => {
  const h = harness({ maxAttempts: 5, attemptWindowMs: 60_000, ttlMs: 300_000 });
  const { code } = generateLoginCodes({ username: 'Alice' }, h.options);

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await verifyLoginCode({ code: `wrong-${index}`, gameId: 'Alice' }, h.options), {
      ok: false,
      reason: 'invalid_code',
    });
  }

  const blocked = await verifyLoginCode({ code, gameId: 'Alice' }, h.options);
  if (blocked.ok) assert.fail('第 6 次尝试本应被限流');
  assert.equal(blocked.reason, 'rate_limited');
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
  assert.equal(blocked.attemptsRemaining, 0);

  // 窗口滑过之后重新允许
  h.advance(60_000);
  assert.equal((await verifyLoginCode({ code, gameId: 'Alice' }, h.options)).ok, true);
});

test('限流按游戏 ID 分别计数', async () => {
  const h = harness({ maxAttempts: 2, attemptWindowMs: 60_000 });
  const { code } = generateLoginCodes({ username: 'Alice' }, h.options);

  for (let index = 0; index < 2; index += 1) {
    assert.equal((await verifyLoginCode({ code: `wrong-${index}`, gameId: 'Alice' }, h.options)).ok, false);
  }

  const alice = await verifyLoginCode({ code, gameId: 'Alice' }, h.options);
  if (alice.ok) assert.fail('Alice 本应被限流');
  assert.equal(alice.reason, 'rate_limited');

  // Bob 是另一条计数桶，还没被限流，但码不属于他
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Bob' }, h.options), {
    ok: false,
    reason: 'game_id_mismatch',
    expectedGameId: 'Alice',
  });
});

test('存储接口可替换：不同 store 之间互不影响', async () => {
  const alice = harness();
  const bob = harness();
  const { code } = generateLoginCodes({ username: 'Alice' }, alice.options);

  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Alice' }, bob.options), {
    ok: false,
    reason: 'invalid_code',
  });
});

test('purge 不会删掉复用了旧颜文字的新记录别名', () => {
  const store = createMemoryLoginCodeStore();
  const kaomoji = '(★‿★)';

  // 旧记录刚过期，还在保留期内
  store.insert(
    storedRecord({
      id: 'old',
      kaomoji,
      ascii: 'HWG-OLD1',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
    })
  );

  // 旧码过期后、保留期结束前，新记录复用了同一个颜文字
  const reusedAt = T0 + LOGIN_CODE_TTL_MS + 1_000;
  store.insert(
    storedRecord({
      id: 'new',
      kaomoji,
      ascii: 'HWG-NEW2',
      createdAt: reusedAt,
      expiresAt: reusedAt + LOGIN_CODE_TTL_MS,
    })
  );
  assert.equal(store.peek(kaomoji)?.id, 'new');

  // 再插入一条记录触发 purge；此时旧记录已超过保留期
  const purgeAt = T0 + LOGIN_CODE_TTL_MS + 60 * 60 * 1000 + 1;
  store.insert(
    storedRecord({
      id: 'third',
      kaomoji: '(☆‿☆)',
      ascii: 'HWG-THIR',
      createdAt: purgeAt,
      expiresAt: purgeAt + LOGIN_CODE_TTL_MS,
    })
  );

  assert.equal(store.peek(kaomoji)?.id, 'new', '旧记录清理后，新记录的颜文字别名必须还在');
  assert.equal(store.peek('hwg-new2')?.id, 'new', '备用码别名也不能被旧记录顺手删掉');
});

test('颜文字池与备用码前缀可用环境变量配置，备用码匹配由前缀派生', async (t) => {
  useEnv(t, {
    LOGIN_CODE_KAOMOJI_POOL: '(A), (B), (A), (C), (D), (E)',
    LOGIN_CODE_FALLBACK_PREFIX: 'X.Y+',
  });

  // 逗号分隔 + 去重
  assert.deepEqual(getKaomojiPool(), ['(A)', '(B)', '(C)', '(D)', '(E)']);
  assert.equal(getFallbackPrefix(), 'X.Y+');

  const h = harness();
  const pool = ['(A)', '(B)', '(C)', '(D)', '(E)'];
  const validCodes = new Set(
    pool.flatMap((first) => pool.filter((second) => second !== first).map((second) => first + second))
  );

  for (let index = 0; index < 5; index += 1) {
    const { code, fallback } = generateLoginCodes({ username: `Player${index}` }, h.options);
    assert.ok(validCodes.has(code), `颜文字码应来自配置池且两个候选不同：${code}`);
    assert.match(fallback, /^X\.Y\+-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);

    // 前缀含正则元字符时，匹配仍必须生效，且大小写不敏感
    const verified = await verifyLoginCode(
      { code: fallback.toLowerCase(), gameId: `Player${index}` },
      h.options
    );
    assert.equal(verified.ok, true);
  }
});

test('环境变量为空时退回默认颜文字池与前缀', (t) => {
  useEnv(t, {
    LOGIN_CODE_KAOMOJI_POOL: '  ',
    LOGIN_CODE_FALLBACK_PREFIX: undefined,
  });

  assert.deepEqual(getKaomojiPool(), KAOMOJI_POOL);
  assert.equal(getFallbackPrefix(), FALLBACK_PREFIX);
});

/* ------------------------------------------------------------------ *
 * SQLite store
 * ------------------------------------------------------------------ */

test('SQLite 默认 store 懒加载：不传 store 也能生成和校验', async (t) => {
  useTempDb(t);

  const { code } = generateLoginCodes({ username: 'Alice' });
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Alice' }), {
    ok: true,
    username: 'Alice',
    gameId: 'Alice',
  });
});

test('SQLite store 用 game_id 列保留显式 gameId，ASCII 查码大小写不敏感', async (t) => {
  const h = sqliteHarness(t);

  const generated = generateLoginCodes({ username: 'Alice', gameId: 'AliceMC' }, h.options);
  const record = h.store.peek(generated.code);
  assert.equal(record?.username, 'Alice');
  assert.equal(record?.gameId, 'AliceMC');
  assert.equal(record?.kaomoji, generated.code);
  assert.equal(record?.ascii, generated.fallback);
  assert.equal(record?.usedAt, null);
  assert.equal(record?.expiresAt, generated.expiresAt);
  // id 保持普通 UUID，不再承载 gameId。
  assert.match(
    record?.id ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );

  const row = getDb()
    .prepare('SELECT game_id FROM login_codes WHERE id = ?')
    .get(record?.id ?? '') as { game_id: string } | undefined;
  assert.equal(row?.game_id, 'AliceMC');

  assert.deepEqual(
    await verifyLoginCode(
      { code: ` ${generated.fallback.toLowerCase()} `, gameId: 'alicemc' },
      h.options
    ),
    { ok: true, username: 'Alice', gameId: 'AliceMC' }
  );
});

test('SQLite store 直接写入的显式 gameId 落在 game_id 列', (t) => {
  const h = sqliteHarness(t);

  h.store.insert(
    storedRecord({
      id: 'explicit',
      username: 'Alice',
      gameId: 'AliceMC',
      kaomoji: '(★‿★)',
      ascii: 'HWG-GAME',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
    })
  );

  const record = h.store.peek('(★‿★)');
  assert.equal(record?.id, 'explicit');
  assert.equal(record?.username, 'Alice');
  assert.equal(record?.gameId, 'AliceMC');

  const row = getDb()
    .prepare('SELECT game_id FROM login_codes WHERE id = ?')
    .get('explicit') as { game_id: string } | undefined;
  assert.equal(row?.game_id, 'AliceMC');
});

test('SQLite store 的 confirm 原子消费：第二次校验得到 used', async (t) => {
  const h = sqliteHarness(t);
  const { code, fallback } = generateLoginCodes({ username: 'Alice' }, h.options);

  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Alice' }, h.options), {
    ok: true,
    username: 'Alice',
    gameId: 'Alice',
  });
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });
  assert.deepEqual(await verifyLoginCode({ code: fallback, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'used',
  });
});

test('SQLite store 的登录码按时过期', async (t) => {
  const h = sqliteHarness(t);
  const early = generateLoginCodes({ username: 'Alice' }, h.options);
  const late = generateLoginCodes({ username: 'Alice' }, h.options);

  h.advance(LOGIN_CODE_TTL_MS - 1);
  assert.equal((await verifyLoginCode({ code: early.code, gameId: 'Alice' }, h.options)).ok, true);

  h.advance(1);
  assert.deepEqual(await verifyLoginCode({ code: late.code, gameId: 'Alice' }, h.options), {
    ok: false,
    reason: 'expired',
  });
});

test('SQLite store 复用颜文字/备用码时后来的记录生效，清理后仍可查询', (t) => {
  const h = sqliteHarness(t);
  const kaomoji = '(★‿★)';

  h.store.insert(
    storedRecord({
      id: 'old',
      kaomoji,
      ascii: 'HWG-OLD1',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
    })
  );

  const reusedAt = T0 + LOGIN_CODE_TTL_MS + 1_000;
  h.store.insert(
    storedRecord({
      id: 'new',
      kaomoji,
      ascii: 'HWG-NEW2',
      createdAt: reusedAt,
      expiresAt: reusedAt + LOGIN_CODE_TTL_MS,
    })
  );

  assert.equal(h.store.peek(kaomoji)?.id, 'new');
  assert.equal(h.store.peek('hwg-new2')?.id, 'new');

  // 更晚的插入会触发保留期清理；新记录仍在保留期内，不能被顺手删掉。
  const purgeAt = reusedAt + 60 * 60 * 1000 + 1;
  h.store.insert(
    storedRecord({
      id: 'third',
      kaomoji: '(☆‿☆)',
      ascii: 'HWG-THR3',
      createdAt: purgeAt,
      expiresAt: purgeAt + LOGIN_CODE_TTL_MS,
    })
  );

  assert.equal(h.store.peek(kaomoji)?.id, 'new');
  assert.equal(h.store.peek('(☆‿☆)')?.id, 'third');
});

test('SQLite store 在 insert 前清理超过保留期的记录', (t) => {
  const h = sqliteHarness(t);

  h.store.insert(
    storedRecord({
      id: 'old',
      kaomoji: '(★‿★)',
      ascii: 'HWG-OLD1',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
    })
  );
  assert.equal(h.store.peek('(★‿★)')?.id, 'old');

  const later = T0 + LOGIN_CODE_TTL_MS + 60 * 60 * 1000 + 1;
  h.store.insert(
    storedRecord({
      id: 'third',
      kaomoji: '(☆‿☆)',
      ascii: 'HWG-THR3',
      createdAt: later,
      expiresAt: later + LOGIN_CODE_TTL_MS,
    })
  );

  assert.equal(h.store.peek('(★‿★)'), undefined);
  assert.equal(h.store.peek('HWG-OLD1'), undefined);
  assert.equal(h.store.peek('(☆‿☆)')?.id, 'third');
});

test('SQLite store 跨连接持久化', async (t) => {
  useTempDb(t);

  const first = createSqliteLoginCodeStore();
  const generated = generateLoginCodes(
    { username: 'Alice', gameId: 'AliceMC' },
    { store: first, now: () => T0 }
  );

  closeDb();

  // 显式 gameId 存在 game_id 列里，重连后仍能按列读回。
  const second = createSqliteLoginCodeStore();
  assert.deepEqual(
    await verifyLoginCode(
      { code: generated.code, gameId: 'alicemc' },
      { store: second, now: () => T0 + 1_000 }
    ),
    { ok: true, username: 'Alice', gameId: 'AliceMC' }
  );
});

test('SQLite store 按游戏 ID 独立限流', async (t) => {
  const h = sqliteHarness(t, { maxAttempts: 2, attemptWindowMs: 60_000 });
  const { code } = generateLoginCodes({ username: 'Alice' }, h.options);

  for (let index = 0; index < 2; index += 1) {
    assert.equal(
      (await verifyLoginCode({ code: `wrong-${index}`, gameId: 'Alice' }, h.options)).ok,
      false
    );
  }

  const alice = await verifyLoginCode({ code, gameId: 'Alice' }, h.options);
  if (alice.ok) assert.fail('Alice 本应被限流');
  assert.equal(alice.reason, 'rate_limited');

  assert.deepEqual(await verifyLoginCode({ code, gameId: 'Bob' }, h.options), {
    ok: false,
    reason: 'game_id_mismatch',
    expectedGameId: 'Alice',
  });
});

test('SQLite 默认 store 在 closeDb 后仍可用：连接经 provider 每次重新解析', async (t) => {
  useTempDb(t);

  const { code, fallback } = generateLoginCodes({ username: 'ReopenUser' });
  closeDb();

  // 默认 store 实例被缓存（保留限流内存态），但不再握死旧连接：
  // getDb 会按当前 HYDWIND_DB_PATH 重开同一个库文件，重开前生成的码仍可校验。
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'ReopenUser' }), {
    ok: true,
    username: 'ReopenUser',
    gameId: 'ReopenUser',
  });
  assert.deepEqual(await verifyLoginCode({ code: fallback, gameId: 'ReopenUser' }), {
    ok: false,
    reason: 'used',
  });
});

test('SQLite 默认 store 跟随 HYDWIND_DB_PATH 切换：旧码 invalid，新码可用', async (t) => {
  useTempDb(t);

  const { code } = generateLoginCodes({ username: 'PathUser' });
  closeDb();

  const dir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-code-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.HYDWIND_DB_PATH = path.join(dir, 'hydwind.sqlite');

  // 新库文件里没有旧码
  assert.deepEqual(await verifyLoginCode({ code, gameId: 'PathUser' }), {
    ok: false,
    reason: 'invalid_code',
  });

  // 同一个缓存 store 实例对新库正常生成和校验
  const fresh = generateLoginCodes({ username: 'PathUser' });
  assert.deepEqual(await verifyLoginCode({ code: fresh.code, gameId: 'PathUser' }), {
    ok: true,
    username: 'PathUser',
    gameId: 'PathUser',
  });
});

test('SQLite store 插入冲突只顶掉已用/已过期的旧行，交叉字段冲突同样处理', (t) => {
  const h = sqliteHarness(t);

  // 已使用的旧行占住 (★‿★) / HWG-OLD1
  h.store.insert(
    storedRecord({
      id: 'used-old',
      kaomoji: '(★‿★)',
      ascii: 'HWG-OLD1',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
      usedAt: T0 + 1_000,
    })
  );

  // 新记录的 kaomoji 撞旧记录的 ascii（交叉冲突）；旧行已用 → 让位
  h.store.insert(
    storedRecord({
      id: 'cross-new',
      kaomoji: 'HWG-OLD1',
      ascii: '(☆‿☆)',
      createdAt: T0 + 2_000,
      expiresAt: T0 + 2_000 + LOGIN_CODE_TTL_MS,
    })
  );
  assert.equal(h.store.peek('HWG-OLD1')?.id, 'cross-new');
  assert.equal(h.store.peek('(★‿★)'), undefined);

  // 已过期但还在保留期内的旧行同样让位
  h.store.insert(
    storedRecord({
      id: 'expired-old',
      kaomoji: '(◕‿◕)',
      ascii: 'HWG-EXP1',
      createdAt: T0,
      expiresAt: T0 + 1_000,
    })
  );
  h.store.insert(
    storedRecord({
      id: 'fresh-new',
      kaomoji: '(◕‿◕)',
      ascii: 'HWG-NEW9',
      createdAt: T0 + 2_000,
      expiresAt: T0 + 2_000 + LOGIN_CODE_TTL_MS,
    })
  );
  assert.equal(h.store.peek('(◕‿◕)')?.id, 'fresh-new');
});

test('SQLite store 不顶掉仍 active 的旧行：冲突插入抛错，旧码保持可用', (t) => {
  const h = sqliteHarness(t);

  h.store.insert(
    storedRecord({
      id: 'active-old',
      kaomoji: '(★‿★)',
      ascii: 'HWG-LIVE',
      createdAt: T0,
      expiresAt: T0 + LOGIN_CODE_TTL_MS,
    })
  );

  // 同 kaomoji 的 active 旧行不让位：UNIQUE 约束抛错，事务回滚
  assert.throws(() =>
    h.store.insert(
      storedRecord({
        id: 'intruder',
        kaomoji: '(★‿★)',
        ascii: 'HWG-NEW7',
        createdAt: T0 + 1_000,
        expiresAt: T0 + 1_000 + LOGIN_CODE_TTL_MS,
      })
    )
  );
  assert.equal(h.store.peek('(★‿★)')?.id, 'active-old');
  assert.equal(h.store.peek('HWG-NEW7'), undefined);

  // 交叉字段（新 kaomoji = 旧 ascii）撞上 active 旧行：不删旧行，两行共存，
  // 查询取更晚创建的记录（与内存 store「后来的覆盖先前的」一致）。
  h.store.insert(
    storedRecord({
      id: 'cross-active',
      kaomoji: 'HWG-LIVE',
      ascii: 'HWG-CRS8',
      createdAt: T0 + 3_000,
      expiresAt: T0 + 3_000 + LOGIN_CODE_TTL_MS,
    })
  );
  assert.equal(h.store.peek('HWG-LIVE')?.id, 'cross-active');

  // 旧记录仍可按 id 原子消费，玩家手里的码没被偷走
  assert.deepEqual(h.store.confirm('active-old', T0 + 4_000), { ok: true });
});