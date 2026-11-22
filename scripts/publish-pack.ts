import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ClientPackSpec } from '../src/launcher/pack-publisher.ts';
import {
  DEFAULT_API_BASE,
  PackPublishError,
  defaultPackOutDir,
  parsePackSpec,
  publishClientPack,
  resolveClientPack,
  serializeClientPackDraft,
} from '../src/launcher/pack-publisher.ts';

/**
 * 客户端包发布 CLI：只做参数解析与本地 I/O。
 *
 * 用法：
 *   npm run publish-pack -- <spec.json> [--out DIR] [--publish]
 *     [--api-base URL] [--modrinth-base URL] [--token-env NAME]
 *
 * 退出码：0 成功；1 解析/网络/发布失败；2 参数错误。
 * `--publish` 的令牌默认取 `LAUNCHER_ADMIN_TOKEN`，可用 `--token-env` 改名。
 */

const USAGE = [
  '用法: npm run publish-pack -- <spec.json> [--out DIR] [--publish]',
  '  [--api-base URL] [--modrinth-base URL] [--token-env NAME]',
  '',
  '  --out DIR            输出目录，默认 dist/pack-<createdAt>',
  '  --publish            上传到管理接口',
  '  --api-base URL       管理接口基址，默认 http://127.0.0.1:8787',
  '  --modrinth-base URL  覆盖 spec.modrinthApiBase',
  '  --token-env NAME     管理令牌环境变量，默认 LAUNCHER_ADMIN_TOKEN',
].join('\n');

export interface PublishPackCliOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedArguments {
  specPath: string;
  out?: string;
  publish: boolean;
  apiBase: string;
  modrinthBase?: string;
  tokenEnv: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const takeValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${flag} 缺少参数值`);
  }
  return value;
};

const parseArguments = (argv: string[]): ParsedArguments | 'help' => {
  let out: string | undefined;
  let publish = false;
  let apiBase = DEFAULT_API_BASE;
  let modrinthBase: string | undefined;
  let tokenEnv = 'LAUNCHER_ADMIN_TOKEN';
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        return 'help';
      case '--out':
        out = takeValue(argv, index, '--out');
        index += 1;
        break;
      case '--publish':
        publish = true;
        break;
      case '--api-base':
        apiBase = takeValue(argv, index, '--api-base');
        index += 1;
        break;
      case '--modrinth-base':
        modrinthBase = takeValue(argv, index, '--modrinth-base');
        index += 1;
        break;
      case '--token-env':
        tokenEnv = takeValue(argv, index, '--token-env');
        index += 1;
        break;
      default:
        if (argument.startsWith('--')) throw new CliUsageError(`未知参数: ${argument}`);
        positionals.push(argument);
    }
  }

  if (positionals.length !== 1) throw new CliUsageError('必须提供一个 spec.json 路径');
  return {
    specPath: positionals[0],
    out,
    publish,
    apiBase: apiBase.replace(/\/+$/, ''),
    modrinthBase,
    tokenEnv,
  };
};

const readSpec = (specPath: string): ClientPackSpec => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    throw new PackPublishError(`读取 spec 失败: ${(error as Error).message}`);
  }

  return parsePackSpec(raw);
};

const isAbsolute = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

export const main = async (
  argv: string[],
  options: PublishPackCliOptions = {}
): Promise<number> => {
  const stdout = options.stdout ?? ((message: string) => console.log(message));
  const stderr = options.stderr ?? ((message: string) => console.error(message));
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  let parsed: ParsedArguments | 'help';
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr((error as Error).message);
    stderr(USAGE);
    return 2;
  }

  if (parsed === 'help') {
    stdout(USAGE);
    return 0;
  }

  const specPath = resolve(cwd, parsed.specPath);

  try {
    // 令牌缺失时尽早失败，避免白跑一遍 Modrinth 解析。
    let token = '';
    if (parsed.publish) {
      token = (env[parsed.tokenEnv] ?? '').trim();
      if (!token) {
        stderr(`环境变量 ${parsed.tokenEnv} 未设置，无法发布`);
        return 1;
      }
    }

    let spec = readSpec(specPath);
    if (spec.overridesDir && !isAbsolute(spec.overridesDir)) {
      spec = { ...spec, overridesDir: resolve(dirname(specPath), spec.overridesDir) };
    }

    const resolved = await resolveClientPack(spec, {
      fetchImpl: options.fetchImpl,
      now: options.now,
      modrinthApiBase: parsed.modrinthBase ?? spec.modrinthApiBase,
    });

    const packJson = serializeClientPackDraft(resolved.pack);
    const outDir = resolve(cwd, parsed.out ?? defaultPackOutDir(resolved.pack.createdAt));
    mkdirSync(outDir, { recursive: true });

    const packPath = join(outDir, 'pack.json');
    writeFileSync(packPath, packJson, 'utf8');
    stdout(`已生成客户端包: ${packPath}`);

    if (resolved.overridesZip) {
      const overridesPath = join(outDir, 'overrides.zip');
      writeFileSync(overridesPath, resolved.overridesZip);
      stdout(`已生成 overrides: ${overridesPath}（${resolved.overridesZip.length} 字节）`);
    }

    if (!parsed.publish) return 0;

    const result = await publishClientPack(resolved.pack, {
      token,
      apiBase: parsed.apiBase,
      overridesZip: resolved.overridesZip,
      packJson,
      fetchImpl: options.fetchImpl,
    });
    stdout(`已发布 packVersion: ${result.packVersion}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`发布客户端包失败: ${message}`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}