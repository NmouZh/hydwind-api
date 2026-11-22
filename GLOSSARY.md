# hydwind-api Glossary

| 术语 | 含义 |
| --- | --- |
| 归一化清单 | 后端把 Mojang version JSON、加载器 profile 与规则过滤后返回给启动器的统一安装清单 |
| 客户端包（client pack） | 服务器权威的完整客户端描述：包版本、游戏版本、加载器、Java 要求、固定版本的模组清单与可选配置覆盖；通过 `GET /api/launcher/client` 公开读取 |
| 包版本（packVersion） | 客户端包单调递增的整数版本，由服务端在发布时分配；变化表示启动器需要同步。与 Minecraft 版本、加载器版本不是同一概念 |
| 模组清单（mod manifest） | 客户端包中锁定到确切 Modrinth 版本与文件的 mod 列表；依赖在发布时展开，启动器零解析 |
| 配置覆盖（overrides） | 客户端包携带的配置文件 zip 与逐文件 `sha256`/`size` 清单；按包版本不可变，用于让玩家客户端与服务器配置一致 |
| 发布（publish） | 用 `npm run publish-pack` 把 spec 解析为客户端包并（可选）上传 `PUT /api/launcher/admin/client-pack` 的过程 |
| 客户端包管理令牌 | `LAUNCHER_ADMIN_TOKEN`，只用于客户端包发布接口；与 `ISSUE_ADMIN_TOKEN`、`PLUGIN_TOKEN` 独立，未配置时发布接口一律 401 |
| 版本保留 | 发布成功后只保留最近 5 个客户端包版本（含当前），更旧的版本目录被清理 |
| 上游 | Mojang、Fabric、Quilt、Forge、NeoForge、Modrinth 等外部元数据与文件来源 |
| 镜像 | 对上游 URL 的重写（BMCLAPI、mcimirror），不改变文件哈希；客户端包内始终保存官方 CDN URL |
| 插件令牌 | `PLUGIN_TOKEN`，只用于 `/api/plugin/*` 的 Bearer 鉴权 |
| 站务令牌 | `ISSUE_ADMIN_TOKEN`，用于注册、议题审核等管理接口 |
| JSON 导入 | 首次启动把旧 `accounts.json` / `biographies.json` / `issues.json` 迁入 SQLite 的一次性过程 |
