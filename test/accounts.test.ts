import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { closeDb } from '../src/db/database.ts';
import {
  ACCOUNT_ROLES,
  findAccount,
  generatePassword,
  isValidUsername,
  listAccounts,
  normalizeUsername,
  publicAccount,
  registerAccount,
  setAccountRole,
  verifyLogin,
} from '../src/domain/accounts.ts';
import {
  ensureBiographyForAccount,
  findBiographyByGameId,
} from '../src/domain/biographies.ts';

/**
 * 账号存储层（SQLite）。
 *
 * 每个用例用独立的临时数据库文件，结束后 closeDb 并把连接复位；
 * 断言只走公开函数观察持久化后的行为，不碰 SQLite 内部结构。
 */

const useTempDb = (t: TestContext): void => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hydwind-api-acc-'));
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

test('normalizeUsername 只保留字母数字下划线并限长 16', () => {
  assert.equal(normalizeUsername('  Ali ce!! '), 'Alice');
  assert.equal(normalizeUsername('a'.repeat(20)), 'a'.repeat(16));
  assert.equal(normalizeUsername(123), '');
  assert.equal(normalizeUsername(null), '');

  assert.equal(isValidUsername('abc'), true);
  assert.equal(isValidUsername('a_1'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('a b'), false);
  assert.equal(isValidUsername('a'.repeat(17)), false);
});

test('generatePassword 默认 10 位，只含不易混淆字符', () => {
  const password = generatePassword();
  assert.equal(password.length, 10);
  assert.match(password, /^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  assert.equal(generatePassword(4).length, 4);

  for (let index = 0; index < 20; index += 1) {
    assert.doesNotMatch(generatePassword(), /[0O1Il]/);
  }
});

test('ACCOUNT_ROLES 对外仍是 admin/player', () => {
  assert.deepEqual(ACCOUNT_ROLES, ['admin', 'player']);
});

test('registerAccount 新账号：自动密码、player、平台身份落库', async (t) => {
  useTempDb(t);

  const result = await registerAccount({
    username: 'Alice',
    platformId: 'qq-10001',
    nickname: '爱丽丝',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.created, true);
  assert.equal(result.value.username, 'Alice');
  assert.equal(result.value.role, 'player');
  assert.equal(result.value.password.length, 10);

  const before = await findAccount('ALICE');
  assert.equal(before?.username, 'Alice');
  assert.equal(before?.nickname, '爱丽丝');
  assert.equal(before?.platform, 'qq');
  assert.equal(before?.platformId, 'qq-10001');
  assert.equal(before?.role, 'player');
  // 注册后还没登录过：Account.lastLoginAt 是数据库 NULL。
  assert.equal(before?.lastLoginAt, null);
  // 新账号的 updatedAt 与 createdAt 是同一次写入的同一个时间。
  assert.equal(before?.updatedAt, before?.createdAt);

  const login = await verifyLogin('alice', result.value.password);
  assert.ok(login);
  assert.equal(login?.username, 'Alice');
  assert.equal(login?.nickname, '爱丽丝');
  assert.ok(login?.lastLoginAt);

  const after = await findAccount('Alice');
  assert.equal(after?.lastLoginAt, login?.lastLoginAt);
});

test('registerAccount 使用合法的手抄密码；过短密码退回自动生成', async (t) => {
  useTempDb(t);

  const custom = await registerAccount({
    username: 'Alice',
    platformId: 'qq-1',
    password: 'secret6',
  });
  assert.equal(custom.ok, true);
  if (!custom.ok) return;
  assert.equal(custom.value.password, 'secret6');
  assert.ok(await verifyLogin('Alice', 'secret6'));

  // 同一平台身份重复注册：5 位密码不合法，改回自动生成；旧密码作废。
  const regenerated = await registerAccount({
    username: 'Alice',
    platformId: 'qq-1',
    password: '12345',
  });
  assert.equal(regenerated.ok, true);
  if (!regenerated.ok) return;
  assert.equal(regenerated.value.created, false);
  assert.notEqual(regenerated.value.password, '12345');
  assert.ok(await verifyLogin('Alice', regenerated.value.password));
  assert.equal(await verifyLogin('Alice', 'secret6'), null);
});

test('platform 归一化为小写，platformId 接受数字', async (t) => {
  useTempDb(t);

  const result = await registerAccount({
    username: 'Alice',
    platformId: 10001,
    platform: ' QQ ',
  });
  assert.equal(result.ok, true);

  const account = await findAccount('Alice');
  assert.equal(account?.platform, 'qq');
  assert.equal(account?.platformId, '10001');
});

test('同一平台身份重复注册：重置密码、改名并迁移传记', async (t) => {
  useTempDb(t);

  const first = await registerAccount({
    username: 'OldPilot',
    platformId: 'qq-10001',
    nickname: '老名字',
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const before = await findAccount('OldPilot');
  await ensureBiographyForAccount({ username: 'OldPilot' });

  // 同一个平台身份重新注册，账号名换成新游戏 ID；未传 nickname 时保留旧昵称。
  const renamed = await registerAccount({ username: 'NewPilot', platformId: 'qq-10001' });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  assert.equal(renamed.value.created, false);
  assert.equal(renamed.value.role, 'player');
  assert.ok(await verifyLogin('NewPilot', renamed.value.password));

  const after = await findAccount('NewPilot');
  assert.equal(after?.nickname, '老名字');
  assert.equal(after?.platformId, 'qq-10001');
  assert.equal(after?.createdAt, before?.createdAt);
  assert.equal(await findAccount('OldPilot'), undefined);

  // 账号改名后传记键跟着迁移。
  assert.equal(await findBiographyByGameId('OldPilot'), null);
  assert.equal((await findBiographyByGameId('NewPilot'))?.gameId, 'NewPilot');
});

test('账号名唯一忽略大小写；改名撞上别的账号时拒绝', async (t) => {
  useTempDb(t);

  const alice = await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  assert.equal(alice.ok, true);

  const duplicate = await registerAccount({ username: 'alice', platformId: 'qq-2' });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.message, /已被占用/);

  const bob = await registerAccount({ username: 'Bob', platformId: 'qq-2' });
  assert.equal(bob.ok, true);

  // Bob 的平台身份想改名成 Alice：撞上已有账号名。
  const clash = await registerAccount({ username: 'Alice', platformId: 'qq-2' });
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.match(clash.message, /已被其他玩家占用/);

  assert.equal((await findAccount('Bob'))?.platformId, 'qq-2');
});

test('同名不同平台身份也拒绝；失败不会留下半成品', async (t) => {
  useTempDb(t);

  await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  const other = await registerAccount({ username: 'Alice', platformId: 'qq-2' });
  assert.equal(other.ok, false);

  assert.equal((await listAccounts()).length, 1);
  assert.equal((await findAccount('Alice'))?.platformId, 'qq-1');
});

test('注册校验：用户名格式与平台身份必填', async (t) => {
  useTempDb(t);

  for (const username of ['ab', 'a b!', '中文名字', '']) {
    const result = await registerAccount({ username, platformId: 'qq-1' });
    assert.equal(result.ok, false, `应拒绝账号名 ${JSON.stringify(username)}`);
  }

  const missingPlatform = await registerAccount({ username: 'Alice', platformId: '   ' });
  assert.equal(missingPlatform.ok, false);
  if (!missingPlatform.ok) assert.match(missingPlatform.message, /平台身份/);

  assert.equal((await listAccounts()).length, 0);
});

test('role：显式 admin 保留，未知值退回 player', async (t) => {
  useTempDb(t);

  const admin = await registerAccount({
    username: 'Root',
    platformId: 'qq-root',
    role: 'admin',
  });
  assert.equal(admin.ok, true);
  if (!admin.ok) return;
  assert.equal(admin.value.role, 'admin');
  assert.equal((await verifyLogin('Root', admin.value.password))?.role, 'admin');

  const fallback = await registerAccount({
    username: 'Player',
    platformId: 'qq-player',
    role: 'root',
  });
  assert.equal(fallback.ok, true);
  if (!fallback.ok) return;
  assert.equal(fallback.value.role, 'player');
});

test('仅大小写不同的重复注册更新账号名大小写但不新建账号', async (t) => {
  useTempDb(t);

  await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  const again = await registerAccount({ username: 'ALICE', platformId: 'qq-1' });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.created, false);
  assert.equal(again.value.username, 'ALICE');

  const accounts = await listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal((await findAccount('alice'))?.username, 'ALICE');
});

test('listAccounts 不含密码哈希，按创建顺序返回', async (t) => {
  useTempDb(t);

  const zed = await registerAccount({ username: 'Zed', platformId: 'qq-z' });
  const amy = await registerAccount({ username: 'Amy', platformId: 'qq-a' });
  assert.equal(zed.ok, true);
  assert.equal(amy.ok, true);

  const accounts = await listAccounts();
  assert.deepEqual(
    accounts.map((account) => account.username),
    ['Zed', 'Amy']
  );
  assert.equal('passwordHash' in accounts[0], false);
  assert.equal(accounts[0].lastLoginAt, null);
  assert.equal(accounts[0].updatedAt, accounts[0].createdAt);
});

test('updated_at 语义：注册等于创建，登录不刷新，改名与改角色刷新', async (t) => {
  useTempDb(t);

  const created = await registerAccount({ username: 'OldPilot', platformId: 'qq-1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const initial = await findAccount('OldPilot');
  assert.equal(initial?.updatedAt, initial?.createdAt);
  const afterRegister = initial?.updatedAt;

  // 登录只写 last_login_at，不改 updated_at（与原 Web 一致）。
  const login = await verifyLogin('OldPilot', created.value.password);
  assert.ok(login);
  assert.equal((await findAccount('OldPilot'))?.updatedAt, afterRegister);

  // 同一平台身份改注册（改名 + 重置密码）会刷新 updated_at，created_at 不变。
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
  const renamed = await registerAccount({ username: 'NewPilot', platformId: 'qq-1' });
  assert.equal(renamed.ok, true);
  const afterRename = await findAccount('NewPilot');
  assert.ok(Date.parse(afterRename?.updatedAt ?? '') > Date.parse(afterRegister ?? ''));
  assert.equal(afterRename?.createdAt, initial?.createdAt);

  // 改角色同样刷新 updated_at。
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
  assert.equal(await setAccountRole('NewPilot', 'admin'), true);
  const afterRole = await findAccount('NewPilot');
  assert.ok(Date.parse(afterRole?.updatedAt ?? '') > Date.parse(afterRename?.updatedAt ?? ''));
});

test('setAccountRole 改角色；未知账号返回 false', async (t) => {
  useTempDb(t);

  const created = await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  assert.equal(created.ok, true);

  assert.equal(await setAccountRole('alice', 'admin'), true);
  assert.equal((await findAccount('Alice'))?.role, 'admin');

  assert.equal(await setAccountRole('Nobody', 'admin'), false);
  assert.equal(await setAccountRole('Alice', 'player'), true);
  assert.equal((await findAccount('Alice'))?.role, 'player');
});

test('findAccount 返回数据库里的密码哈希（scrypt 格式）', async (t) => {
  useTempDb(t);

  const created = await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const account = await findAccount('Alice');
  assert.match(account?.passwordHash ?? '', /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!(account?.passwordHash ?? '').includes(created.value.password));
});

test('verifyLogin 对错误密码、空密码、超长密码和未知账号一律返回 null', async (t) => {
  useTempDb(t);

  const created = await registerAccount({ username: 'Alice', platformId: 'qq-1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(await verifyLogin('Alice', 'wrong-password'), null);
  assert.equal(await verifyLogin('Alice', ''), null);
  assert.equal(await verifyLogin('Alice', 'x'.repeat(201)), null);
  assert.equal(await verifyLogin('Nobody', created.value.password), null);
  assert.equal(await verifyLogin('', created.value.password), null);

  // 失败尝试不会写 last_login_at。
  assert.equal((await findAccount('Alice'))?.lastLoginAt, null);
});

test('publicAccount 只暴露公开字段', async (t) => {
  useTempDb(t);

  await registerAccount({
    username: 'Alice',
    platformId: 'qq-1',
    nickname: '爱丽丝',
  });
  const account = await findAccount('Alice');
  if (!account) assert.fail('Alice 应已存在');

  assert.deepEqual(publicAccount(account), {
    username: 'Alice',
    nickname: '爱丽丝',
    role: 'player',
    createdAt: account.createdAt,
    lastLoginAt: null,
  });
});