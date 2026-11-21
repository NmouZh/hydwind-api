# Forge / NeoForge 客户端安装器调研

调研日期 2026-11-21。依据：Forge Installer 2.0 源码、HMCL/PCL 源码，并实际解包 Forge 1.8.9 / 1.12.2 / 1.20.1 与 NeoForge 1.20.1 / 21.5.75 安装器。

## TL;DR

- 现代安装器是「数据驱动的 Java 小程序流水线」：`install_profile.json` 描述库、处理器、数据占位符，`version.json` 是给启动器用的版本清单。不要运行安装器 GUI，自己按 profile 下载并依次执行处理器即可。
- 处理器就是普通 JVM 进程（main class + classpath + args），输入输出都在 `libraries/`，官方安装器甚至用 `URLClassLoader` 在进程内调用。Flutter 侧用子进程执行最可控。
- 只处理 `client`：过滤 `sides`，忽略 `serverJarPath`，绝不运行 server 处理器。
- 三条兼容路径：旧版 `install`+`versionInfo`（1.8.9 / 1.12.2 早期）、过渡版 `spec:0`+`json`+内嵌 maven（1.12.2-2859，无处理器）、处理器版（1.13+；`spec` 可能是 0 也可能是 1，如 1.16.5 为 0、1.20.1/NeoForge 为 1）。用 key 检测，不要用 MC 版本猜。
- HMCL 自己执行处理器；PCL2 不自己跑，而是用 `com.bangbang93.ForgeInstaller` 包装器代跑。Flutter 推荐前者，依赖少且每一步可校验。

## 1. 包结构与字段

现代安装器 jar 根目录固定包含 `install_profile.json` 和它 `json` 字段指向的 `version.json`；库/数据可能以 `maven/...`、`data/...` 形式内嵌。

| 字段 | 含义 / 用法 |
| --- | --- |
| `spec` | 0 或 1。Forge `Util.loadInstallProfile`：0 解析为 `Install`，1 为 `InstallV1`，其它值报错；`Install` 本身也含 libraries/processors/data，所以 spec:0 不代表没有处理器（1.16.5 就是 spec:0）。HMCL 只要看到 `spec` 就按新版处理 |
| `profile` | 启动器 profile 名，Forge 为 `forge`，现代 NeoForge 为 `NeoForge` |
| `version` | 安装出的版本名，如 `1.20.1-forge-47.2.0`、`neoforge-21.5.75` |
| `minecraft` | 目标原版版本，用于 `{MINECRAFT_VERSION}` 和版本匹配校验 |
| `json` | 包内 `version.json` 路径，通常 `/version.json` |
| `path` | 可选的主产物坐标；若安装器内嵌 `maven/<path>`，拷贝到 `libraries/<path>` |
| `libraries` | **安装期**依赖（处理器及其 classpath）；Mojang library 结构；可被 `maven/` 内嵌 |
| `processors` | 有序处理器列表：`sides`、`jar`、`classpath`、`args`、`outputs` |
| `data` | 变量表：每个 key 有 `client`/`server` 两个值 |
| `serverJarPath` | 仅 server（1.17+ 用来藏 server jar），客户端忽略 |
| `icon/logo/welcome/mirrorList/hide*` | 官方安装器 GUI 用，启动器可忽略 |

`version.json` 与 `install_profile.json` 是两套东西：前者是启动器版本清单（`id`、`inheritsFrom`、`mainClass`、`arguments`、`libraries`、`downloads`、`logging`），后者只描述如何安装。官方客户端安装流程见 `ClientInstall.run`：把 `version.json` 原样写到 `versions/<version>/<version>.json`，下载原版 jar，下载库，跑处理器，最后改 `launcher_profiles*.json`。([ClientInstall.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/actions/ClientInstall.java))

实测：Forge 1.20.1 的 profile `libraries` 有 46 项（installertools/jarsplitter/ART/binarypatcher 等），`version.json.libraries` 有 29 项（启动期库）；两套都需要下载。

## 2. 处理器与坐标解析

**Maven 坐标** `[group:artifact:version[:classifier][@ext]]`，默认 `ext=jar`。路径规则：`group.replace('.','/')/artifact/version/artifact-version[-classifier].ext`。Forge `Artifact.from` 与 HMCL `Artifact.fromDescriptor` 一致；HMCL 还把 group 中的 `\` 规范成 `/`。([Forge Artifact.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Artifact.java)、[HMCL Artifact.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/Artifact.java))

**`data` 值的三种语法**（官方 `PostProcessors.loadData` 与 HMCL `parseLiteral` 一致）：

1. `[maven:coord@ext]` → 解析为 `libraries/` 下的本地文件路径；
2. `'literal'` → 去掉单引号后的字面量（例如 MCP 版本、outputs 里的 SHA-1）；
3. 其它 → 安装器 jar 内条目（如 `/data/client.lzma`），抽取到临时目录并替换为绝对路径。

**内置变量**（`InstallV1` 注释明确新增）：`{SIDE}`（client/server/extract）、`{MINECRAFT_JAR}`、`{MINECRAFT_VERSION}`、`{ROOT}`、`{INSTALLER}`、`{LIBRARY_DIR}`。data 中原有的键（`MAPPINGS`、`MOJMAPS`、`BINPATCH`、`MC_SLIM`、`MC_SRG`、`PATCHED` 等）也都能在 args 中引用。参数替换支持行内 `{KEY}`；`'...'` 表示字面量；`\` 是转义符；未知 key 直接报错。([InstallV1.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/InstallV1.java)、[Util.replaceTokens](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Util.java))

**sides**：`sides` 缺省 = 所有侧都运行；只处理包含 `client` 的项。HMCL 在 `ForgeNewInstallProfile.getProcessors()` 里直接过滤 client。([ForgeNewInstallProfile.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallProfile.java))

**执行一个处理器**（HMCL `ProcessorTask` / 官方 `PostProcessors.process`）：

1. `jar` 坐标定位 `libraries/<jar path>`，读取 jar 清单的 `Main-Class`；
2. classpath = profile 中 `classpath` 各项（必须已下载）+ 处理器 jar 本身；
3. args 逐项做 `[maven]` / 字面量 / `{token}` 替换；
4. 启动 JVM：HMCL 用 `java -cp ... <mainClass> <args...>` 外部进程；官方用 `URLClassLoader` 在安装器进程内反射调用 `main`；
5. 退出码非 0 → 失败。

**outputs SHA-1**：`outputs` 的 key/value 都按上述字面量规则替换，value 是 SHA-1。执行前若所有输出文件存在且 SHA-1 全匹配，则跳过该处理器；执行后逐个校验，不匹配则删除并失败。([PostProcessors.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/actions/PostProcessors.java))

注意两个现实差异：
- Forge 1.20.1 只有 jarsplitter 声明 outputs；NeoForge 21.5.75 的解包结果显示所有处理器 `outputs` 为 null，所以不能假设每个处理器都可缓存。
- zlib-ng 等原生压缩库会让安装器“动态生成”的 jar SHA-1 与官方值不同。HMCL 的策略是：jar 输出哈希不匹配时，退化为 ZIP 结构校验并记录警告；TechnicPack 则探测处理器 JVM 的 zlib-ng 并提示用户。([ForgeNewInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallTask.java)、[TechnicPack 文档](https://github.com/TechnicPack/LauncherV3/blob/master/docs/modern-forge-and-neoforge-installation.md))

**可选优化**：HMCL 会识别 `DOWNLOAD_MOJMAPS` 处理器，改为直接从 Mojang 版本 JSON 的 `downloads.client_mappings` 下载，省掉一次 installertools 启动。([ForgeNewInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallTask.java))

## 3. 旧格式兼容（1.8.9 / 1.12.2）

**检测**：HMCL `detectForgeInstallerType` 以 `install_profile.json` 的 key 判断——有 `spec` → 新版；有 `install`+`versionInfo` → 旧版；否则报错。([ForgeInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeInstallTask.java))

**旧版字段**：
- `install`：`profileName`、`target`、`path`（主 jar 的 maven 坐标）、`version`、`filePath`（jar 内 universal jar 条目）、`minecraft`；
- `versionInfo`：完整的版本 JSON（`id`、`inheritsFrom`、`mainClass`、`minecraftArguments`、`libraries`）。

**处理流程**（HMCL `ForgeOldInstallTask`，PCL“Legacy 方式 2”同）：
1. 校验 `install.minecraft` 与目标原版版本一致；
2. 把 zip 内 `install.filePath` 解出到 `libraries/<install.path 的 maven 路径>`；
3. 把 `versionInfo` 写成 `versions/<新 id>/<新 id>.json`，把 `id` 改成实例名，`inheritsFrom` 缺失时补上目标原版版本；
4. 不做任何处理器。([ForgeOldInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeOldInstallTask.java)、[PCL ModDownloadLib.vb](https://github.com/Meloong-Git/PCL/blob/main/Plain%20Craft%20Launcher%202/Pages/PageDownload/ModDownloadLib.vb))

实测：Forge 1.8.9-11.15.0.1661 与 1.12.2-14.23.5.2768 都是 `install`+`versionInfo`；`versionInfo.jar` 指向原版版本（`1.8.9`/`1.12.2`），universal jar 作为普通 library（`url` 指向 Forge maven，无 `downloads`）。([1.8.9 安装器](https://maven.minecraftforge.net/net/minecraftforge/forge/1.8.9-11.15.0.1661/forge-1.8.9-11.15.0.1661-installer.jar)、[1.12.2 安装器](https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2768/forge-1.12.2-14.23.5.2768-installer.jar))

**过渡格式**：Forge 1.12.2-14.23.5.2859 的 `spec` 是 0，但没有 `install`/`versionInfo`，而是 `json:/version.json` + `path` + 内嵌 `maven/.../forge-...jar`，`processors` 为空。HMCL 因为有 `spec` 走新版任务，PCL 走“Legacy 方式 1”（无 `install` 时复制 `json` 指向的版本 JSON 和 maven 目录）。这说明**检测必须看 key，不能只看 `spec` 或 MC 版本**。另一个反例是 Forge 1.16.5：`spec:0` 但 `processors`/`data` 齐全，属于标准处理器安装。([1.12.2-2859 安装器](https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859-installer.jar)、[1.16.5 安装器](https://maven.minecraftforge.net/net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39-installer.jar))

## 4. 版本 JSON 合并与 patched client jar

安装阶段最稳妥的做法：把 `version.json` 原样写进 `versions/<id>/<id>.json`，不要在原文件里做合并；启动时再解析 `inheritsFrom`。HMCL 用 patch 模型（`GameInstancePatch` 优先级 30000）延迟合并；PCL 在读取版本 JSON 时递归合并。([HMCL GameInstancePatch](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/GameInstancePatch.java))

合并规则（HMCL `GameInstanceManifest.merge` / `DefaultGameRepositorySnapshot.resolve`，PCL `ModMinecraft.vb` 相同）：

- 递归解析 `inheritsFrom`，检测环和缺失父版本；`jar` 子版本优先，否则继承父版本的 `jar`；根版本默认 `jar=id`。
- 标量字段子版本优先：`mainClass`、`minecraftArguments`、`assetIndex`、`assets`、`javaVersion`、`type`、`time`。
- `arguments.game` / `arguments.jvm` 数组：父版本在前、子版本在后。Forge 版本 JSON 会追加 `--launchTarget forgeclient`、ModLauncher/BootstrapLauncher 的 JVM 参数；不能直接替换掉原版参数。HMCL 实现为 `Arguments.merge(parent.arguments, arguments)`；PCL 用 `JObject.Merge`（数组 Concat）。
- `libraries`：子版本在前、父版本在后（类路径优先级）。HMCL 启动前 `uniqueLibraries` 去重：按 `group:artifact` + 相同 rules，新版本胜出；同版本但坐标载荷不同（如 natives）都保留。([HMCL GameInstanceManifest.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/GameInstanceManifest.java)、[LaunchManifestNormalizer.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/LaunchManifestNormalizer.java))

**patched client jar 的位置**：
- Forge 1.13–1.16（ModLauncher）：处理器把补丁后的客户端写到 `libraries/net/minecraftforge/forge/<ver>/forge-<ver>-client.jar`（data 里的 `PATCHED` 坐标）；版本 JSON 里另外会有普通 `net.minecraftforge:forge:<ver>` 库，1.16.5 的该项 `downloads.artifact.url` 为空，实际从安装器内嵌 `maven/` 取。不要试图用空 URL 下载。
- Forge 1.17+ / 1.20.1 与 NeoForge（BootstrapLauncher）：patched jar 同样在 `libraries/...-client.jar`，`version.json.libraries` 不列出它；BootstrapLauncher 通过 `-DlibraryDirectory` 和 FML 元数据自行找到。原版 jar 仍是 `versions/<mc>/<mc>.jar`。
- 永远不要把 patched jar 覆盖到原版 `versions/<mc>/<mc>.jar`；`{MINECRAFT_JAR}` 必须是未修改的原版客户端 jar。HMCL 还会先把原版 jar 复制到临时目录再交给处理器，避免处理器污染共享缓存。([ForgeNewInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallTask.java))

**ignoreList 坑**：Forge 1.17+ 的 JVM 参数含 `-DignoreList=${version_name}.jar`。若把原版 jar 复制到“loader 版本 id”的目录并用它作为主 jar，BootstrapLauncher 可能把主 jar 自己排除掉。TechnicPack 的做法是把已校验的原版副本放在 `bin/native-launch/<loader-version-id>.jar`；更简单的是像 HMCL 一样保持 `jar` 指向原版版本 id。([TechnicPack 文档](https://github.com/TechnicPack/LauncherV3/blob/master/docs/modern-forge-and-neoforge-installation.md))

## 5. Forge 与 NeoForge 的差异

| 项 | Forge | NeoForge 1.20.1（旧） | NeoForge 1.20.2+（现代） |
| --- | --- | --- | --- |
| installer 坐标 | `net.minecraftforge:forge:<mc>-<forge>` | `net.neoforged:forge:1.20.1-<ver>` | `net.neoforged:neoforge:<ver>` |
| 下载主机 | `maven.minecraftforge.net` | `maven.neoforged.net/releases` | `maven.neoforged.net/releases` |
| `profile` | `forge` | `forge`（但包含 neoforge 标记） | `NeoForge` |
| `version` / version.json `id` | `1.20.1-forge-47.2.0` | `1.20.1-forge-47.1.106` | `neoforge-21.5.75` |
| 工具坐标 | `net.minecraftforge:installertools` / `jarsplitter` / `ForgeAutoRenamingTool` / `binarypatcher` | 与 Forge 相同 | `net.neoforged.installertools:installertools` / `jarsplitter` / `binarypatcher:fatjar`；`net.neoforged:AutoRenamingTool` |
| data 中的 mappers | `de.oceanlabs.mcp:mcp_config:...` | `de.oceanlabs.mcp:mcp_config:...` | `net.neoforged:neoform:<mc>-<timestamp>` |
| patched 坐标 | `net.minecraftforge:forge:<ver>:client` | `net.neoforged:forge:<ver>:client` | `net.neoforged:neoforge:<ver>:client` |
| 识别方式 | profile=`forge` | profile=`forge` + 包含 `neoforge` 字符串（HMCL 也看 `META-INF/NEOFORGE.RSA`） | profile=`NeoForge`/`neoforge` |

其他差异：
- 现代 NeoForge 的版本号 `<major>.<minor>.<build>` 映射到 MC 版本（21.5.75 → 1.21.5），1.20.1 是例外，必须用 `net.neoforged:forge`。HMCL 的解析逻辑见 [NeoForgeRemoteVersion.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/neoforge/NeoForgeRemoteVersion.java)。
- 两者安装器 main class 都是 `net.minecraftforge.installer.SimpleInstaller`（NeoForge 复用 Forge Installer 代码），所以不能靠 main class 区分。
- NeoForge 21.5.75 的处理器不声明 outputs，且 NeoForge 使用自己的 installertools/ART 版本；执行顺序和变量语法与 Forge 相同，按 `sides`/顺序跑即可。([实测 profile](https://maven.neoforged.net/releases/net/neoforged/neoforge/21.5.75/neoforge-21.5.75-installer.jar))
- HMCL 对 NeoForge 有专门的组件 id 归一化（`forge` → `neoforge`）和版本前缀清理；启动器内部用统一 loader 类型即可。([NeoForgeInstallTask.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/neoforge/NeoForgeInstallTask.java))

## 6. Flutter 最小可靠实现

不跑官方 installer 黑盒；按 profile 自己执行。PCL2 的做法（`com.bangbang93.ForgeInstaller` 包装器）可作为兜底，但多一个二进制依赖且仍需 JVM。([PCL ModDownloadLib.vb](https://github.com/Meloong-Git/PCL/blob/main/Plain%20Craft%20Launcher%202/Pages/PageDownload/ModDownloadLib.vb))

```text
install(installerJar, mcDir, mcVersion):
  verify installer sha1/size (version list 或 maven .sha1)
  zip = open(installerJar)
  p = parse(zip["install_profile.json"])

  if p["install"] != null:                 # 旧格式
     assert p.install.minecraft == mcVersion
     dest = librariesPath(p.install.path)  # maven 规则
     extract(zip[p.install.filePath]) -> dest, sha1 if listed
     v = p.versionInfo; v.id = newId; v.inheritsFrom ??= mcVersion
     write versions/newId/newId.json = v

  else:                                     # 现代 / 过渡格式
     assert p.minecraft == mcVersion
     v = parse(zip[p.json])
     ensure vanilla versions/mcVersion/mcVersion.jar (Mojang sha1)
     copy every zip["maven/..."] entry -> libraries/...   # 官方先查内嵌 maven
     download p.libraries + v.libraries:
        use downloads.artifact {path,url,sha1,size} if present
        else if url non-empty: url + mavenPath
        else: must already exist (内嵌/处理器产物)
     data = for each (k, entry.client):    # [..] -> lib path; '..' -> literal
        else extract zip[entry.client] -> temp dir, use abs path
     data += { SIDE:client, MINECRAFT_JAR:copy(vanilla jar),
               MINECRAFT_VERSION:mcVersion, ROOT:mcDir,
               INSTALLER:abs(installerJar), LIBRARY_DIR:mcDir/libraries }
     for proc in p.processors where sides==null or sides contains "client":
        outs = substitute(proc.outputs)
        if outs non-empty and all exist with matching sha1: continue
        jar = librariesPath(proc.jar); main = jarManifest.Main-Class
        cp = [librariesPath(a) for a in proc.classpath] + [jar]
        args = [substitute(a) for a in proc.args]
        run(java, ["-cp", join(cp, sep), main] + args); require exit 0
        verify outs sha1; on mismatch fail (或 zlib-ng 时做 ZIP 结构校验并告警)
     write versions/v.id/v.id.json = v          # 原样写，保留 inheritsFrom
     # 可选：把 v.id / v.profile 注入 launcher_profiles.json

launch-resolve(versionId):
  while id.inheritsFrom: parent = load(parent); detect cycle/missing
  libraries = child.libraries + parent.libraries
  arguments = concat(parent.game+jvm, child.game+jvm)
  mainClass/minecraftArguments/assetIndex = child ?? parent
  jar = child.jar ?? parent.jar
  dedup libraries: same group:artifact + same rules -> newer version wins
  # patched client 已在 libraries/，不要覆盖原版 jar
```

**Java 选择**：读原版版本 JSON 的 `javaVersion.majorVersion`（1.12.2=8、1.20.1=17、1.21.5=21），处理器与游戏使用同一大版本；Java 8 无法加载 Java 17 字节码，反之亦然。PCL 只选 ≥8 并加 JavaWrapper 兼容层；HMCL 默认用 `JavaRuntime.getDefault()`。Android 上必须内置可用的 JRE。([Mojang 1.21.5 JSON](https://piston-meta.mojang.com/v1/packages/d7eabdfb864d74c6d3942cdb864405778e948f28/1.21.5.json)、[1.20.1](https://piston-meta.mojang.com/v1/packages/fb730d2829f057fe26a41e5ecdc9e3307333bef5/1.20.1.json)、[1.12.2](https://piston-meta.mojang.com/v1/packages/832d95b9f40699d4961394dcf6cf549e65f15dc5/1.12.2.json))

**版本清单参考**：Forge 用官方版本列表或 BMCLAPI；NeoForge 用 `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge`（1.20.1 用 `.../net/neoforged/forge`）。下载镜像可替换主机但要重新校验 SHA-1。

## 7. 必须做的安全校验

- **路径穿越**：解压 zip 时规范化每个 entry；拒绝绝对路径、`..`、符号链接、Windows 盘符；校验最终路径仍在目标目录内。`data` 的安装器内条目、`outputs` 的 key、`version.json` 的 `libraries.downloads.artifact.path` 都不可信。
- **Maven 坐标**：group/artifact/version/classifier 拒绝 `/`、`\`、`..`、空段、绝对路径；ext 只允许白名单（`jar`、`zip`、`txt`、`tsrg`、`lzma` 等）；最终路径必须落在 `libraries/` 内。
- **只跑 client**：`sides` 缺省视为双侧，必须过滤成 `contains("client")`；永不运行 `server` 处理器，忽略 `serverJarPath`；不要运行安装器自身的 main class。
- **SHA-1**：安装器、每个声明了 `downloads.artifact.sha1` 的库、每个 `outputs` 都必须校验；不匹配就删除并失败。没有 SHA 的旧格式 universal jar 至少校验 ZIP 结构；空 URL 的库只能来自内嵌 `maven/`，不要构造猜测 URL。
- **URL**：只允许 HTTPS（Mojang/Forge/NeoForge 或显式镜像白名单）；禁止 `file:`、重定向到私网/回环地址，防 SSRF；下载后再次校验哈希。
- **子进程**：用 argv 数组、不拼 shell；清空/限制 `JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`CLASSPATH`；设置超时、输出大小上限；工作目录指向临时目录；处理器 jar 必须已通过 profile SHA-1。
- **zip 炸弹/资源**：限制 entry 数、单文件与总解压大小、压缩比；临时目录用后删除。
- **原子性**：先写临时目录，校验完再 rename 到 `versions/<id>`；失败不留下半安装版本；不覆盖原版版本目录。
- **审计日志**：记录每个处理器的 jar、classpath、最终 argv、退出码、输出哈希，便于复现和用户报告问题。

## 参考来源

- Forge Installer 2.0：[Install.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Install.java)、[InstallV1.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/InstallV1.java)、[Artifact.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Artifact.java)、[Util.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Util.java)、[PostProcessors.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/actions/PostProcessors.java)、[ClientInstall.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/actions/ClientInstall.java)、[DownloadUtils.java](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/DownloadUtils.java)
- HMCL：[ForgeNewInstallTask](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallTask.java)、[ForgeNewInstallProfile](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallProfile.java)、[ForgeOldInstallTask](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeOldInstallTask.java)、[ForgeInstallTask](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeInstallTask.java)、[NeoForgeInstallTask](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/neoforge/NeoForgeInstallTask.java)、[Artifact](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/Artifact.java)、[GameInstanceManifest](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/GameInstanceManifest.java)、[LaunchManifestNormalizer](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/LaunchManifestNormalizer.java)
- PCL2：[ModDownloadLib.vb](https://github.com/Meloong-Git/PCL/blob/main/Plain%20Craft%20Launcher%202/Pages/PageDownload/ModDownloadLib.vb)、[ModMinecraft.vb](https://github.com/Meloong-Git/PCL/blob/main/Plain%20Craft%20Launcher%202/Modules/Minecraft/ModMinecraft.vb)
- 第三方分析：[How do Neoforge installers work](https://notes.highlysuspect.agency/neoforge-installer.html)、[TechnicPack modern Forge/NeoForge installation](https://github.com/TechnicPack/LauncherV3/blob/master/docs/modern-forge-and-neoforge-installation.md)
- 实测安装器：[Forge 1.20.1](https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar)、[Forge 1.12.2 legacy](https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2768/forge-1.12.2-14.23.5.2768-installer.jar)、[Forge 1.8.9](https://maven.minecraftforge.net/net/minecraftforge/forge/1.8.9-11.15.0.1661/forge-1.8.9-11.15.0.1661-installer.jar)、[NeoForge 21.5.75](https://maven.neoforged.net/releases/net/neoforged/neoforge/21.5.75/neoforge-21.5.75-installer.jar)、[NeoForge 1.20.1 legacy](https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar)
- 版本 JSON 结构：[Minecraft Wiki client.json](https://minecraft.wiki/w/Client.json)（注意该页未描述 `inheritsFrom` 合并顺序，合并规则以上述 HMCL/PCL 实现为准）