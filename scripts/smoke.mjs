#!/usr/bin/env node
/**
 * 启动真实服务并用临时数据目录跑最小冒烟。
 *
 * 这里不依赖测试框架：spawn `src/server.ts`，等端口就绪，请求
 * /api/health，最后确保子进程退出。后续接口的完整冒烟会在这里继续扩展。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const waitForHealth = async (url, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`服务未就绪: ${lastError instanceof Error ? lastError.message : lastError}`);
};

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hydwind-api-smoke-'));
const port = await freePort();

const child = spawn(process.execPath, ['src/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_ORIGIN: 'http://localhost:4324',
    HYDWIND_DATA_DIR: dataDir,
    HYDWIND_CONTENT_DIR: path.join(root, 'test', 'fixtures', 'content'),
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

let failed = false;
const check = (condition, message) => {
  if (condition) {
    console.log(`ok - ${message}`);
  } else {
    failed = true;
    console.error(`not ok - ${message}`);
  }
};

try {
  const response = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();
  check(response.status === 200, 'GET /api/health 返回 200');
  check(body.ok === true, 'health.ok === true');
  check(typeof body.uptime === 'number', 'health.uptime 是数字');

  const missing = await fetch(`http://127.0.0.1:${port}/api/not-found`);
  check(missing.status === 404, '未知路径返回 404');
} catch (error) {
  failed = true;
  console.error(error);
  console.error(stderr);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log('smoke passed');