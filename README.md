# hydwind-api

Hydwind 的独立后端。把原本嵌在 `hydwind-web` Astro 站点里的 `/api/*` 拆出来单独运行，并新增启动器使用的清单 API。

- 运行时：Node 26 LTS + Hono 4 + TypeScript（Node 原生类型剥离，无需构建）
- 存储：SQLite（`node:sqlite`），首次启动可从旧 `HYDWIND_DATA_DIR/*.json` 一次性导入
- 上游：Mojang 版本清单、Fabric/Quilt/Forge/NeoForge 元数据、Modrinth v2 API；支持 BMCLAPI 镜像
- 外部契约：`GET /api/health` 与 `POST /api/plugin/login/verify` 必须保持与 `hydwind-gate` 插件兼容

## 本地运行

```bash
npm ci
cp .env.example .env
node --env-file=.env src/server.ts
# http://127.0.0.1:8787/api/health
```

`hydwind-web` 通过 `HYDWIND_API_ORIGIN`（默认 `http://127.0.0.1:8787`）访问本服务；启动器的设置页填写同一个地址。

## 检查

```bash
npm run typecheck
npm test
npm run smoke
```

工作区规则：构建、测试和冒烟一律在 GitHub Actions 跑；本地只做只读检查和单文件语法检查。

## 状态

脚手架阶段：当前只有健康检查与基础配置，后续按计划迁入账号、门禁校验、议题、传记和启动器清单 API。