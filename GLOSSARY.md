# hydwind-api Glossary

| 术语 | 含义 |
| --- | --- |
| 归一化清单 | 后端把 Mojang version JSON、加载器 profile 与规则过滤后返回给启动器的统一安装清单 |
| 上游 | Mojang、Fabric、Quilt、Forge、NeoForge、Modrinth 等外部元数据与文件来源 |
| 镜像 | 对上游 URL 的重写（当前支持 BMCLAPI），不改变文件哈希 |
| 插件令牌 | `PLUGIN_TOKEN`，只用于 `/api/plugin/*` 的 Bearer 鉴权 |
| 站务令牌 | `ISSUE_ADMIN_TOKEN`，用于注册、议题审核等管理接口 |
| JSON 导入 | 首次启动把旧 `accounts.json` / `biographies.json` / `issues.json` 迁入 SQLite 的一次性过程 |