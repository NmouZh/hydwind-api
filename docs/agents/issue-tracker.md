# Issue tracker: GitHub（多仓库工作区）

工作区根目录是 Git 仓库（`NmouZh/hydwind-workspace`），只跟踪跨仓库的约定与文档；每个子仓库使用自己的 GitHub 仓库作为 issue tracker。

## 仓库登记

| 子仓库 | GitHub 仓库 | 说明 |
| --- | --- | --- |
| `hydwind-web/` | `NmouZh/hydwind-web` | 官网前端 |
| `hydwind-gate/` | `NmouZh/hydwind-gate` | Velocity 进服登录门禁插件 |
| `hydwind_launcher/` | `NmouZh/hydwind_launcher` | Flutter 桌面/移动启动器 |

新增子仓库时在此补一行，并在子仓库内配置 `github` remote。

## 定位目标仓库

- 在子仓库目录内运行 `gh`；`github` remote 指向真实仓库，`gh repo view --json nameWithOwner` 可确认目标。
- 若 `gh` 无法推断（例如只有代理 `origin`），显式传 `-R <owner>/<repo>`。
- 不要在工作区根目录直接创建 issue；在根目录操作时必须显式 `-R`。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state`。
- **设为父 issue 的子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id，见 **阻塞**）。不支持子 issue 时，在子 issue 正文首行写 `Part of #<parent>`。
- **阻塞**：GitHub 原生 issue dependency，是规范且 UI 可见的表达。`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 `node_id`）。不可用时退化为子 issue 正文首行 `Blocked by: #<n>, #<n>`。所有阻塞者关闭后该 ticket 才算可开始。
- **统计未关闭阻塞者**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只含未关闭的；0 表示可开始）。`gh issue view <n> --json blockedBy` 也会列出已关闭的，需要过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`。
- **加 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：先 `gh issue comment <number> --body "..."`，再 `gh issue close <number>`。对已关闭的 issue，`gh issue close --comment` 会丢掉评论但仍以 0 退出。

在子仓库内运行前，用 `gh repo view --json nameWithOwner` 确认目标。只向用户自己的仓库提交 issue；不要向 `mattpocock/skills`（这些技能的来源仓库）提交，除非用户拥有它。在 fork 中 `gh` 可能默认指向上游父仓库，所以每个会话第一次 `gh issue create` 前先确认目标，若不是用户的仓库就先问。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（若本仓库把外部 PR 当作功能请求，改成 `yes`；`/triage` 会读这个开关。）_

设为 `yes` 时，PR 与 issue 走同一套标签和状态，使用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number>`，再 `gh pr view <number> --comments`（非 TTY 下 `--comments` 只打印评论，不打印正文），以及 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用一个编号空间，裸 `#42` 可能是任一者：先用 `gh pr view 42` 解析，失败再回退到 `gh issue view 42`。

## When a skill says "publish to the issue tracker"

在相关子仓库创建 GitHub issue。

## When a skill says "fetch the relevant ticket"

按 **读取 issue** 一节读取。

## Wayfinding operations

`/wayfinder` 使用。**map** 是一个 issue，**child** issue 是 ticket。

- **Map**：单个 issue，标签 `wayfinder:map`，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：作为 map 的 GitHub 子 issue 关联（见 **设为父 issue 的子 issue**）。不支持子 issue 时，把 child 加进 map 正文的任务列表，并在 child 正文首行写 `Part of #<map>`。标签：`wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。被认领后 assign 给当前开发者。
- **阻塞**：见 **约定** 里的 **阻塞**。
- **Frontier 查询**：列出 map 的未关闭 child，去掉有未关闭阻塞者（见 **统计未关闭阻塞者**，或正文 `Blocked by` 行里的未关闭 issue）或已有 assignee 的；按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是会话的第一次写操作。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（摘要 + 链接）追加到 map 的 Decisions-so-far。
