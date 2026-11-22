# hydwind-api

通用规则（提交、日报、检查、构建与 Agent skills）见工作区根目录的 `../CLAUDE.md` 与 `../docs/agents/`；本文件只放本仓库特有约定。

## 仓库特有

- 运行时是 Node 26 + Hono 4，TypeScript 直接由 Node 类型剥离执行；不要引入构建器，也不要使用 enum/namespace/参数属性等不可擦除语法。
- 数据库是单实例 SQLite（`node:sqlite`）；不要假设多实例并发。
- `GET /api/health` 与 `POST /api/plugin/login/verify` 是 `hydwind-gate` 插件的硬契约，改动必须先改测试。
- 客户端包的 schema/路径/hash/zip 规则只有一份来源：`src/launcher/client-pack.ts`。发布脚本必须复用 `parseClientPackDraft` 与 `validateOverridesZip`，不要在 `pack-publisher.ts` 里复制一套校验。
- `LAUNCHER_ADMIN_TOKEN` 只用于 `PUT /api/launcher/admin/client-pack`，必须与 `ISSUE_ADMIN_TOKEN`、`PLUGIN_TOKEN` 分开；未配置时管理接口返回 401，读接口保持公开。
- 客户端包存在 `HYDWIND_DATA_DIR/launcher/client-pack/` 的版本化文件里，不要新增 SQLite 表；发布必须保持「临时目录 → rename → 原子写 current.json」的顺序，并保留最近 5 版。
- 改包契约时同步更新：启动器 `lib/models/client_pack.dart` 的解析规则、本仓库 `README.md`/`GLOSSARY.md`、工作区 `docs/plans/2026-11-22-client-pack-verification.md`。两端的上限、Windows 路径规则与 SemVer 规则必须一致。
- issue tracker 是 GitHub `NmouZh/hydwind-api`；领域文档以本仓库 `GLOSSARY.md` 与 `docs/adr/` 为准。
