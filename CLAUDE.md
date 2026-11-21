# hydwind-api

通用规则（提交、日报、检查、构建与 Agent skills）见工作区根目录的 `../CLAUDE.md` 与 `../docs/agents/`；本文件只放本仓库特有约定。

## 仓库特有

- 运行时是 Node 26 + Hono 4，TypeScript 直接由 Node 类型剥离执行；不要引入构建器，也不要使用 enum/namespace/参数属性等不可擦除语法。
- 数据库是单实例 SQLite（`node:sqlite`）；不要假设多实例并发。
- `GET /api/health` 与 `POST /api/plugin/login/verify` 是 `hydwind-gate` 插件的硬契约，改动必须先改测试。
- issue tracker 是 GitHub `NmouZh/hydwind-api`；领域文档以本仓库 `GLOSSARY.md` 与 `docs/adr/` 为准。