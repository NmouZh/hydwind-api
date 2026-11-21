import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb } from '../src/db/database.ts';
import { SCHEMA_SQL } from '../src/db/schema.ts';

const TEMP_PREFIX = path.join(tmpdir(), 'hydwind-db-import-');

const withTempEnv = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(TEMP_PREFIX);
  const savedDataDir = process.env.HYDWIND_DATA_DIR;
  const savedDbPath = process.env.HYDWIND_DB_PATH;

  process.env.HYDWIND_DATA_DIR = dir;
  delete process.env.HYDWIND_DB_PATH;

  try {
    run(dir);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });

    if (savedDataDir === undefined) delete process.env.HYDWIND_DATA_DIR;
    else process.env.HYDWIND_DATA_DIR = savedDataDir;

    if (savedDbPath === undefined) delete process.env.HYDWIND_DB_PATH;
    else process.env.HYDWIND_DB_PATH = savedDbPath;
  }
};

const writeJson = (dir: string, name: string, value: unknown): void => {
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const countRows = (db: DatabaseSync, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as {
    count: number;
  };
  return row.count;
};

const metaValue = (db: DatabaseSync, key: string): string | undefined => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as {
    value: string;
  } | undefined;
  return row?.value;
};

const accountAlice = {
  username: 'Alice',
  nickname: '爱丽丝',
  platform: 'qq',
  platformId: '10001',
  passwordHash: 'scrypt$alice$hash',
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  // 刻意与 createdAt 不同，验证 updated_at 保留旧值。
  updatedAt: '2026-01-20T00:00:00.000Z',
  lastLoginAt: '2026-02-01T00:00:00.000Z',
};

const accountBob = {
  username: 'Bob',
  nickname: '',
  platform: 'qq',
  platformId: 10002,
  passwordHash: 'scrypt$bob$hash',
  role: 'player',
  createdAt: '2026-01-02T00:00:00.000Z',
  // 旧数据可能没有 updatedAt，导入时回退 createdAt。
  lastLoginAt: null,
};

const accountsFixture = { version: 1, accounts: [accountAlice, accountBob] };

const biographiesFixture = {
  version: 1,
  biographies: [
    {
      gameId: 'Alice',
      mainTitle: 'Alice 的传记',
      body: '# 你好',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      comments: [
        {
          id: 'comment-1',
          authorUsername: 'Bob',
          authorGameId: 'Bob',
          body: '第一条评论',
          createdAt: '2026-01-05T00:00:00.000Z',
        },
        {
          id: 'comment-2',
          authorUsername: 'Alice',
          authorGameId: 'Alice',
          body: '第二条评论',
          createdAt: '2026-01-06T00:00:00.000Z',
        },
      ],
    },
  ],
};

const issuesFixture = {
  version: 1,
  nextId: 3,
  issues: [
    {
      id: 1,
      title: '启动器闪退',
      body: '一启动就闪退',
      author: 'Bob',
      category: 'bug',
      status: 'open',
      createdAt: '2026-01-07T00:00:00.000Z',
      updatedAt: '2026-01-08T00:00:00.000Z',
      replies: [
        {
          id: 'reply-uuid-1',
          author: 'Alice',
          body: '收到，正在看',
          createdAt: '2026-01-09T00:00:00.000Z',
          staff: true,
        },
        {
          id: 'reply-uuid-2',
          author: 'Bob',
          body: '谢谢',
          createdAt: '2026-01-10T00:00:00.000Z',
          staff: false,
        },
      ],
    },
    {
      id: 2,
      title: '希望支持深色模式',
      body: '晚上太亮了',
      author: 'Alice',
      category: 'suggestion',
      status: 'pending',
      createdAt: '2026-01-11T00:00:00.000Z',
      updatedAt: '2026-01-11T00:00:00.000Z',
      replies: [],
    },
  ],
};

test('首次启动把三份旧 JSON 导入 SQLite', () => {
  withTempEnv((dir) => {
    writeJson(dir, 'accounts.json', accountsFixture);
    writeJson(dir, 'biographies.json', biographiesFixture);
    writeJson(dir, 'issues.json', issuesFixture);

    const originalAccounts = readFileSync(path.join(dir, 'accounts.json'), 'utf8');
    const originalBiographies = readFileSync(path.join(dir, 'biographies.json'), 'utf8');
    const originalIssues = readFileSync(path.join(dir, 'issues.json'), 'utf8');

    const db = getDb();

    assert.equal(countRows(db, 'accounts'), 2);
    assert.equal(countRows(db, 'biographies'), 1);
    assert.equal(countRows(db, 'comments'), 2);
    assert.equal(countRows(db, 'issues'), 2);
    assert.equal(countRows(db, 'issue_replies'), 2);
    assert.equal(metaValue(db, 'json_import_v1'), 'done');

    // 账号主键 COLLATE NOCASE：小写查询也能命中，并保留原始大小写。
    const alice = db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get('alice') as unknown as Record<string, unknown>;
    assert.equal(alice.username, 'Alice');
    assert.equal(alice.nickname, '爱丽丝');
    assert.equal(alice.platform, 'qq');
    assert.equal(alice.platform_id, '10001');
    assert.equal(alice.password_hash, 'scrypt$alice$hash');
    assert.equal(alice.role, 'admin');
    assert.equal(alice.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(alice.updated_at, '2026-01-20T00:00:00.000Z');
    assert.equal(alice.last_login_at, '2026-02-01T00:00:00.000Z');

    const bob = db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get('BOB') as unknown as Record<string, unknown>;
    assert.equal(bob.username, 'Bob');
    assert.equal(bob.nickname, 'Bob'); // 空昵称回退 username
    assert.equal(bob.platform_id, '10002'); // 数字 platformId 转字符串
    assert.equal(bob.role, 'member'); // 旧 player 映射为 member
    assert.equal(bob.updated_at, '2026-01-02T00:00:00.000Z'); // 缺 updatedAt 回退 createdAt
    assert.equal(bob.last_login_at, null); // 旧 null 原样写 NULL

    const biography = db
      .prepare('SELECT * FROM biographies WHERE game_id = ?')
      .get('ALICE') as unknown as Record<string, unknown>;
    assert.equal(biography.game_id, 'Alice');
    assert.equal(biography.main_title, 'Alice 的传记');
    assert.equal(biography.body, '# 你好');
    assert.equal(biography.created_at, '2026-01-03T00:00:00.000Z');
    assert.equal(biography.updated_at, '2026-01-04T00:00:00.000Z');

    const comments = db
      .prepare(
        'SELECT game_id, author_username, author_game_id, body, created_at FROM comments WHERE game_id = ? ORDER BY created_at'
      )
      .all('alice') as unknown as Record<string, unknown>[];
    assert.equal(comments.length, 2);
    assert.equal(comments[0].game_id, 'Alice');
    assert.equal(comments[0].author_username, 'Bob');
    assert.equal(comments[0].author_game_id, 'Bob');
    assert.equal(comments[0].body, '第一条评论');
    assert.equal(comments[0].created_at, '2026-01-05T00:00:00.000Z');
    assert.equal(comments[1].author_username, 'Alice');
    assert.equal(comments[1].body, '第二条评论');

    const issues = db
      .prepare('SELECT id, title, category, status, author FROM issues ORDER BY id')
      .all() as unknown as Record<string, unknown>[];
    assert.deepEqual(
      issues.map((row) => row.id),
      [1, 2]
    );
    assert.equal(issues[0].title, '启动器闪退');
    assert.equal(issues[0].category, 'bug');
    assert.equal(issues[0].status, 'open');
    assert.equal(issues[0].author, 'Bob');
    assert.equal(issues[1].category, 'suggestion');
    assert.equal(issues[1].status, 'pending');

    const replies = db
      .prepare('SELECT issue_id, author, body, staff, created_at FROM issue_replies ORDER BY id')
      .all() as unknown as Record<string, unknown>[];
    assert.deepEqual(
      replies.map((row) => row.issue_id),
      [1, 1]
    );
    assert.deepEqual(
      replies.map((row) => row.author),
      ['Alice', 'Bob']
    );
    assert.deepEqual(
      replies.map((row) => row.staff),
      [1, 0]
    );
    assert.deepEqual(
      replies.map((row) => row.body),
      ['收到，正在看', '谢谢']
    );
    assert.equal(replies[0].created_at, '2026-01-09T00:00:00.000Z');

    // 旧 issue id 是显式写入的；AUTOINCREMENT 序列应接着最大 id 往后走。
    const inserted = db
      .prepare(
        'INSERT INTO issues (title, body, category, status, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        '新议题',
        '导入之后新建的议题',
        'other',
        'pending',
        null,
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z'
      );
    assert.equal(Number(inserted.lastInsertRowid), 3);

    // 外键 ON DELETE CASCADE：删传记带走评论，删议题带走回复。
    db.prepare('DELETE FROM biographies WHERE game_id = ?').run('alice');
    assert.equal(countRows(db, 'comments'), 0);
    db.prepare('DELETE FROM issues WHERE id = ?').run(1);
    assert.equal(countRows(db, 'issue_replies'), 0);

    // 导入是只读的，原 JSON 文件内容不变。
    assert.equal(readFileSync(path.join(dir, 'accounts.json'), 'utf8'), originalAccounts);
    assert.equal(readFileSync(path.join(dir, 'biographies.json'), 'utf8'), originalBiographies);
    assert.equal(readFileSync(path.join(dir, 'issues.json'), 'utf8'), originalIssues);
  });
});

test('json_import_v1 标记保证关闭重开后不重复导入', () => {
  withTempEnv((dir) => {
    writeJson(dir, 'accounts.json', { version: 1, accounts: [accountAlice] });
    writeJson(dir, 'biographies.json', { version: 1, biographies: [] });
    writeJson(dir, 'issues.json', { version: 1, nextId: 1, issues: [] });

    const first = getDb();
    assert.equal(countRows(first, 'accounts'), 1);
    assert.equal(metaValue(first, 'json_import_v1'), 'done');
    closeDb();

    // 模拟旧站点在迁移后又往 accounts.json 写了一个账号。
    writeJson(dir, 'accounts.json', { version: 1, accounts: [accountAlice, accountBob] });

    const second = getDb();
    assert.equal(countRows(second, 'accounts'), 1);
    assert.equal(metaValue(second, 'json_import_v1'), 'done');
  });
});

test('业务表非空但缺标记时跳过导入、补标记并告警', () => {
  withTempEnv((dir) => {
    writeJson(dir, 'accounts.json', accountsFixture);

    const dbFile = path.join(dir, 'hydwind.sqlite');
    const raw = new DatabaseSync(dbFile);
    try {
      raw.exec(SCHEMA_SQL);
      raw
        .prepare(
          'INSERT INTO accounts (username, nickname, platform, platform_id, password_hash, role, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          'LegacyOnly',
          'LegacyOnly',
          'qq',
          '99999',
          'scrypt$legacy$hash',
          'member',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        );
    } finally {
      raw.close();
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      const db = getDb();
      assert.equal(countRows(db, 'accounts'), 1);
      const row = db
        .prepare('SELECT username FROM accounts')
        .get() as unknown as Record<string, unknown>;
      assert.equal(row.username, 'LegacyOnly');
      assert.equal(countRows(db, 'biographies'), 0);
      assert.equal(countRows(db, 'comments'), 0);
      assert.equal(metaValue(db, 'json_import_v1'), 'done');
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warnings.some((line) => line.includes('json_import_v1')));
    assert.ok(warnings.some((line) => line.includes('跳过')));
  });
});

test('三份 JSON 都不存在时直接写标记', () => {
  withTempEnv(() => {
    const db = getDb();

    assert.equal(countRows(db, 'accounts'), 0);
    assert.equal(countRows(db, 'biographies'), 0);
    assert.equal(countRows(db, 'issues'), 0);
    assert.equal(metaValue(db, 'json_import_v1'), 'done');
  });
});

test('旧 JSON 语法错误抛出清晰错误、不写标记，修复后可重试', () => {
  withTempEnv((dir) => {
    writeFileSync(path.join(dir, 'accounts.json'), '{ "accounts": [', 'utf8');

    assert.throws(() => getDb(), /accounts\.json JSON 解析失败/);

    const raw = new DatabaseSync(path.join(dir, 'hydwind.sqlite'));
    try {
      assert.equal(raw.prepare('SELECT value FROM meta WHERE key = ?').get('json_import_v1'), undefined);
      const row = raw.prepare('SELECT COUNT(*) AS count FROM accounts').get() as unknown as {
        count: number;
      };
      assert.equal(row.count, 0);
    } finally {
      raw.close();
    }

    // 没有留下 marker，修好 JSON 后下一次 getDb 仍会导入。
    writeJson(dir, 'accounts.json', { version: 1, accounts: [accountAlice] });
    const retried = getDb();
    assert.equal(countRows(retried, 'accounts'), 1);
    assert.equal(metaValue(retried, 'json_import_v1'), 'done');
  });
});