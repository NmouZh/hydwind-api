import path from 'node:path';

/**
 * 运行配置。
 *
 * 所有配置从环境变量读取，默认值只服务本地开发；生产部署必须显式配置
 * PUBLIC_ORIGIN、密钥与 HYDWIND_CONTENT_DIR。
 */
export interface AppConfig {
  host: string;
  port: number;
  publicOrigin: string;
  dataDir: string;
  contentDir: string;
  trustedProxyCidrs: string[];
  mirror: 'official' | 'bmclapi';
  modrinthUserAgent: string;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const list = (value: string | undefined, fallback: string): string[] =>
  (value ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, '');

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const mirror = env.HYDWIND_MIRROR?.trim().toLowerCase() === 'bmclapi' ? 'bmclapi' : 'official';

  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: positiveInt(env.PORT, 8787),
    publicOrigin: normalizeOrigin(env.PUBLIC_ORIGIN?.trim() || 'http://localhost:4324'),
    dataDir: path.resolve(env.HYDWIND_DATA_DIR?.trim() || path.join(process.cwd(), 'data')),
    contentDir: path.resolve(
      env.HYDWIND_CONTENT_DIR?.trim() || path.join(process.cwd(), '..', 'hydwind-web', 'src', 'content')
    ),
    trustedProxyCidrs: list(env.TRUSTED_PROXY_CIDRS, '127.0.0.1/32,::1/128'),
    mirror,
    modrinthUserAgent:
      env.MODRINTH_USER_AGENT?.trim() ||
      'hydwind-launcher/0.1.0 (https://github.com/NmouZh/hydwind_launcher)',
  };
};