# hydwind-api

Hydwind 的独立后端。把原本嵌在 `hydwind-web` Astro 站点里的 `/api/*` 拆出来单独运行，提供网站 API、启动器清单 API 与服务器权威的**客户端包**。

- 运行时：Node 26 LTS + Hono 4 + TypeScript（Node 原生类型剥离，无需构建）
- 存储：SQLite（`node:sqlite`）；客户端包用数据目录下的版本化文件存储，不新增表
- 上游：Mojang 版本清单、Fabric/Quilt/Forge/NeoForge 元数据、Modrinth v2 API；清单接口支持 BMCLAPI 镜像，启动器可再把官方 Modrinth URL 重写为 mcimirror
- 外部契约：`GET /api/health` 与 `POST /api/plugin/login/verify` 必须保持与 `hydwind-gate` 插件兼容
- 启动器契约：`/api/launcher/client` 返回客户端包，启动器只按包安装与同步，不自行解析 Modrinth

## 本地运行

```bash
npm ci
cp .env.example .env
node --env-file=.env src/server.ts
# http://127.0.0.1:8787/api/health
```

发布客户端包前，在 `.env` 中额外设置 `LAUNCHER_ADMIN_TOKEN`（`.env.example` 已列出占位值，部署时换成独立随机令牌）。未配置时管理接口一律返回 401，读接口不受影响。

`hydwind-web` 通过 `HYDWIND_API_ORIGIN`（默认 `http://127.0.0.1:8787`）访问本服务；启动器的设置页填写同一个地址。

## 客户端包（client pack）

客户端包是服务器权威的完整客户端描述：包版本、游戏版本、加载器、Java 要求、固定版本的 mods 与可选的配置覆盖。玩家不需要理解版本、加载器或 mod，启动器启动前自动拉取并同步。

### 路由

| 路由 | 鉴权 | 行为 |
| --- | --- | --- |
| `GET /api/launcher/client` | 公开 | 返回当前 `pack.json`；未发布返回 404 `{ "error": "not_found" }` |
| `GET /api/launcher/client/overrides/:packVersion` | 公开 | 返回该版本的 `overrides.zip`；版本不存在或非法返回 404 |
| `PUT /api/launcher/admin/client-pack` | `Authorization: Bearer $LAUNCHER_ADMIN_TOKEN` | `multipart/form-data` 发布新包，返回 200 + 完整包 JSON |

- 读接口公开、不需要账号，沿用启动器读接口的 120 请求/分钟限流（429 `rate_limited` + `retry-after`）。管理接口不套读接口限流，令牌是边界。
- `GET /client` 的 `ETag` 是原始 `pack.json` 字节的 SHA-256（带引号）；`cache-control: no-cache`。`If-None-Match` 支持逗号列表、`W/` 与 `*`，命中返回 304（无 body，仍带 ETag）。
- overrides 按版本不可变：200 带 `content-type: application/zip`、`content-length` 与 `cache-control: public, max-age=31536000, immutable`。
- 管理接口鉴权先于请求体限制：缺少、错误或未配置令牌一律 401，不会因为请求体过大变成 413。
- `multipart` 字段：`pack`（JSON 文本，必填）与 `overrides`（zip 文件，可选）；请求体总上限 64 MiB。没有 zip 时 `pack` 不得带 `overrides`，上传 zip 时 `pack` 必须带对应清单；overrides 文件本身超过 50 MiB 返回 413。

### 包文档

```json
{
  "schemaVersion": 1,
  "kind": "client-pack",
  "packVersion": 7,
  "createdAt": "2026-11-22T12:00:00Z",
  "notes": "更新 Sodium、修正按键配置",
  "gameVersion": "26.3",
  "loader": { "type": "fabric", "version": "0.20.1" },
  "java": { "major": 25, "component": "java-runtime-epsilon" },
  "minLauncherVersion": "0.5.0",
  "mods": [
    {
      "projectId": "AANobbMI",
      "versionId": "abc123",
      "name": "Sodium",
      "versionNumber": "0.6.0",
      "filename": "sodium-0.6.0.jar",
      "url": "https://cdn.modrinth.com/data/.../....jar",
      "sha512": "128 位十六进制",
      "size": 123
    }
  ],
  "overrides": {
    "url": "/api/launcher/client/overrides/7",
    "sha256": "64 位十六进制",
    "size": 456,
    "files": [{ "path": "config/foo.toml", "sha256": "64 位十六进制", "size": 12 }]
  }
}
```

`packVersion` 与 `overrides.url` 由服务端生成；发布输入里出现会被拒绝，避免发布者误以为可以指定。读取端忽略未知字段，为后续 `verification` 预留。

### 校验规则与上限

- 文档：`schemaVersion` 必须为 1，`kind` 必须为 `client-pack`，`createdAt` 可解析，`notes` ≤ 500 字符。
- 加载器：`fabric` / `quilt` / `forge` / `neoforge`；`gameVersion` 与加载器版本使用版本 id 字符集。
- Java：`java.major` 为 1–99；`java.component` 可选（托管运行时组件名，缺失时启动器不能自动下载 Java）。
- 版本门槛：`minLauncherVersion` 必须是严格 SemVer（允许预发布与 `+build`）。
- mods：最多 200 个；`projectId` / `versionId` 为 `[A-Za-z0-9_-]{1,64}`；`projectId` 与 `filename` 均不得重复（文件名按大小写不敏感去重）；URL 必须是 `https://cdn.modrinth.com/...`；`sha512` 为 128 位小写十六进制；单个文件 1–512 MiB。
- 文件名与 overrides 路径：拒绝绝对路径、`..`、空段、反斜杠、控制字符、Windows 尾点/尾空格、NTFS 冒号与 `con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9` 保留设备名。
- overrides：1–2000 个文件；逐文件 `sha256` 与 `size`；解压总量 ≤ 50 MiB；路径不得仅大小写不同而重复。
- zip 严格一致：zip 大小与哈希必须匹配清单；条目数、每条路径、大小与 SHA-256 必须与 `files` 完全一致；拒绝目录条目、符号链接、重复条目与本地头不一致。
- 服务端分配 `packVersion`，先写临时版本目录、`rename` 为正式目录，再原子替换 `current.json`；并发发布在进程内串行，不会拿到同一版本。发布失败时当前版本不变。
- 默认保留最近 5 个版本（含当前）；清理旧版本失败只记日志，不影响已完成的发布。`current.json` 内容损坏时按现有版本目录继续编号；文件系统错误照常抛出。

### 存储

```text
<HYDWIND_DATA_DIR>/launcher/client-pack/
  current.json                 # { "packVersion": 7 }
  versions/<packVersion>/pack.json
  versions/<packVersion>/overrides.zip
```

`current.json` 只存当前版本指针；读取时先读指针，再读对应版本的原始 `pack.json`，ETag 直接对原始字节计算，避免重编码导致缓存失效。

### 错误语义

| 状态 | 场景 | body |
| --- | --- | --- |
| 200 | 读取或发布成功 | 包 JSON；overrides 为 zip 字节 |
| 304 | `If-None-Match` 命中 | 空 body，仍带 ETag |
| 400 | 发布输入不合法（schema、路径、哈希、zip、字段组合） | `{ "error": "invalid_request", "message": "..." }` |
| 401 | 管理令牌缺失、错误或未配置 | `{ "error": "unauthorized" }` |
| 404 | 尚未发布客户端包；overrides 版本不存在或非法 | `{ "error": "not_found" }` |
| 413 | 请求体总大小超过 64 MiB，或 overrides 文件超过 50 MiB | `{ "error": "请求体太大" }` |
| 429 | 读接口超过 120 请求/分钟 | `{ "error": "rate_limited" }` + `retry-after` |
| 500 | 存储或未预期错误 | `{ "error": "internal_error" }` |

发布失败不会改变当前版本；400 的 `message` 会指出具体字段或 zip 条目，便于修正发布输入。

## 发布客户端包

发布脚本把「列出 Modrinth 项目」变成可复现的包，并可选直接上传管理接口：

```bash
npm run publish-pack -- <spec.json> [--out DIR] [--publish]
  [--api-base URL] [--modrinth-base URL] [--token-env NAME]
```

- `--out DIR`：输出目录，默认 `dist/pack-<createdAt>`。
- `--publish`：上传到管理接口；令牌默认取环境变量 `LAUNCHER_ADMIN_TOKEN`，可用 `--token-env` 改名。
- `--api-base URL`：管理接口基址，默认 `http://127.0.0.1:8787`。
- `--modrinth-base URL`：覆盖 spec 里的 `modrinthApiBase`，便于走镜像；包内始终保存官方 `cdn.modrinth.com` URL。

spec 输入：

```json
{
  "notes": "更新 Sodium",
  "gameVersion": "26.3",
  "loader": { "type": "fabric", "version": "0.20.1" },
  "java": { "major": 25, "component": "java-runtime-epsilon" },
  "minLauncherVersion": "0.5.0",
  "mods": ["sodium", { "project": "iris", "version": "可选 versionId" }],
  "overridesDir": "overrides",
  "modrinthApiBase": "可选，默认 https://api.modrinth.com/v2"
}
```

- spec 的未知顶层字段、`loader`/`java` 未知键直接拒绝；`overridesDir` 拼错不会被静默忽略。
- 默认选 Modrinth `release` 版本（按 `date_published` 取最新，日期相同按 version id 稳定排序）；显式 `version` 直接使用该 versionId，但仍校验游戏版本与加载器，且必须属于所请求的项目。
- 加载器兼容：Quilt 接受 Fabric 版本；Forge 与 NeoForge 不互认。依赖与直接列出的项目都按同一规则校验。
- 递归展开 `dependency_type == "required"` 的依赖；可选依赖忽略；依赖项目 `client_side == "unsupported"` 跳过，直接列出的项目则报错。依赖只给 `version_id` 时反查所属项目。环依赖按「已解析同版本即满足」处理，版本冲突报错。
- 拒绝重复 project（含 slug/id 别名）、重复 filename、超过 200 个 mod、版本不属于项目或版本列表混入其它项目。
- 每个 mod 选择 `primary` 文件（否则第一个），必须带 `sha512`、`size`、`filename` 与官方 CDN URL；`name` / `versionNumber` 超长会截断到契约上限。
- `overridesDir` 相对路径由 CLI 相对 **spec 文件所在目录** 解析；库调用方需自行传绝对路径。递归扫描拒绝符号链接、非普通文件、反斜杠、控制字符、Windows 保留字符与首尾空白；生成确定性 zip（条目按路径排序、固定时间戳、UTF-8），并写出逐文件 `sha256`/`size`；上限 2000 文件 / 解压 50 MiB / zip 50 MiB；目录为空时省略 overrides。
- 输出 `pack.json`（2 空格缩进 + 换行）与（有 overrides 时）`overrides.zip`；复用输出目录会删除上次遗留的 `overrides.zip`；输出目录不得位于 overrides 目录内。
- 生成后会用与服务端相同的 `parseClientPackDraft` / `validateOverridesZip` 自校验，保证「发布能过、读取也能过」。

退出码：`0` 成功；`1` 解析、网络、校验或发布失败；`2` 参数错误。`--publish` 成功时打印返回的 `packVersion`；令牌缺失会在请求 Modrinth 前直接失败。

## 其它启动器接口

`/api/launcher/versions`、`/loaders`、`/manifest`、`/manifest/normalize` 与 `/modrinth/*` 仍按 ADR-0002 的归一化清单契约提供。客户端包引用这份清单安装原版与加载器，不重复定义版本 JSON；Forge/NeoForge 在启动器侧执行 installer processors 后调用 `POST /manifest/normalize`。

## 检查

```bash
npm run typecheck
npm test
npm run smoke
```

工作区规则：构建、测试和冒烟一律在 GitHub Actions 跑；本地只做只读检查和单文件语法检查。客户端包路由与发布脚本的测试都在进程内注入临时数据目录、假 fetch 与固定时钟，不访问真实网络。

## CI

- `.github/workflows/ci.yml`：push / PR 到 `main` 与 `feat/**` 时跑 `npm ci` → `npm run typecheck` → `npm test` → `npm run smoke`。
- `.github/workflows/upstream.yml`：手动或每周一 03:17 UTC 拉取真实 Mojang / Fabric / Forge / NeoForge 清单，检查上游格式与镜像可用性。

## 状态

已迁入健康检查、账号、插件校验、进服码、服务器状态、头像、议题与回复、待审、人物/传记/评论，以及启动器清单 API 与客户端包资源。客户端包路由与发布脚本的 CI 已通过（2026-11-22，`feat/client-pack`）；启动器侧的同步与四加载器验收见工作区 `docs/plans/2026-11-22-client-pack-verification.md`。

## 已知限制

- 尚无部署配置；生产部署方式待定。`LAUNCHER_ADMIN_TOKEN` 需要在部署环境单独配置，不能复用 `ISSUE_ADMIN_TOKEN`。
- `.env.example` 里的 `LAUNCHER_ADMIN_TOKEN` 只是占位值，部署时必须替换为独立随机令牌。
- 客户端包目前只支持 Modrinth 来源；CurseForge 与其它来源不在范围内。
- 服务端校验客户端 mod 列表（阶段 D）尚未实现；包格式已保留可选字段槽位。
- 路径与文件名规则按 UTF-16 码元与大小写不敏感比较，未做 Unicode NFC 归一化；跨平台边界见 `src/launcher/client-pack.ts` 的注释与测试。
