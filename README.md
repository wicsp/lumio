# Lumio

Lumio 是我按自己的工作流维护的 pi extension 工具集合。

## 为什么做 Lumio

我安装过很多 pi extension，但逐渐发现几个问题：

- 不同 extension 之间会有不需要的功能；
- 很多功能彼此重复；
- 预制功能往往难以深度定制；
- 这些能力由 npm 包管理，强依赖上游维护节奏。

这和 pi 的理念并不一致。pi 的价值在于**简洁、透明、可定制**。如果引入大量预制 harness，最终体验会越来越接近 Hermes、Claude Code、Codex 等现成工具，而不是一个按自己意愿塑形的 agent 环境。

所以 Lumio 的定位是：

> 除 pi 本身外，不安装任何第三方插件；第三方 extension 只作为参考，把真正需要的功能复制、裁剪或重新实现到自己的工具集合中。

## 设计原则

- **个人需求驱动**：只加入自己确实会用的功能。
- **可读可改**：代码应足够小，方便随时调整。
- **避免重复**：新增功能前先确认现有能力不能覆盖。
- **少依赖上游**：尽量不新增 runtime dependencies。
- **渐进维护**：先实现最小可用版本，再根据使用体验扩展。

## 项目结构

```text
lumio/
├── extensions/   # pi extensions
├── prompts/      # prompt templates
├── themes/       # themes
├── AGENTS.md     # 给编码代理的项目约束
└── package.json  # pi package manifest
```

## 安装

### 持久化安装（推荐）

把 lumio 注册为 pi 本地 package，之后每次启动 pi 都会自动加载：

```bash
pi install <path-to-lumio>
```

安装后重启 pi 即可生效。用 `/lumio` 命令可以确认加载状态。

### 卸载

```bash
pi uninstall lumio
```

### 更新

修改 lumio 代码后无需重新安装——pi 直接从源目录加载。重启 pi 会话即可看到最新改动。

### 临时加载（不持久化）

仅本次会话加载，不写入配置：

```bash
pi -e <path-to-lumio>
```

## 注册的功能

当前 extension 会注册：

- `/lumio`：显示 Lumio 已加载状态。
- `/fast [on|off|toggle|status]`：按当前 provider 独立控制 Claude/OpenAI Fast mode。
- `/quiet-tools on|off|toggle|status`：控制折叠状态下的内置工具静默预览。
- Lumio permission gate：在 `bash` 工具执行前拦截危险命令，必要时请求确认或直接阻止。
- Lumio dirty repo guard：在有未提交变更时，切换会话或 fork 前请求确认。
- Lumio minimal footer：替换默认 footer，显示 branch、repo、context、model、thinking level，并在上下文过大时提示 `DUMB ZONE`。
- Lumio quiet tools：覆盖内置 `bash/read/grep/find/ls/edit/write` 的 TUI renderer，让折叠工具行只显示一行调用和展开提示，不改变模型可见的工具结果。
- Gnosis、Librarian、Oracle、review、triage、questionnaire 和 workflow audit 等本地工具与命令。
- Atlas 交互入口：捕获 Bilibili/Web Source、触发版本化 Workflow、查看状态，并将 Atlas Resource 投影到 Vortex。
- Lumio Web Clipper：Chrome 中只有一个 `Send to Atlas` 按钮；浏览器提取当前已渲染页面，Lumio 经本机 bridge 写入 extraction Artifact 并排队正常网页摘要。
- Bark 与桌面/终端完成通知。

### Atlas / Vortex 工作流

Lumio 不再领取或执行任何 Atlas Run，也不注册 legacy capability。Bilibili、Web 摘要、
观点对比、Console 发起的评论草稿/同步和 Resource 清理全部由独立 AtlasRunner 执行。
Lumio 只保留捕获/命令入口、状态查看以及当前 Pi 会话中的 Vortex/Obsidian 交互。

需要本地受保护资源的 Workflow 必须在 AtlasRunner 的 node-local manifest 中显式授权；
Lumio 不上报这些 grants。Atlas attempt 和 Runner manifest 必须同时允许 Cookie、Artifact
删除、Vortex 读写或 Atlas control 写入等权限。

- `/atlas:enqueue <Bilibili URL>`：先在 Atlas 幂等创建 Source，再排队执行摘要 Run。
- `chrome-extension/atlas-capture`：以 unpacked extension 安装后点击 `Send to Atlas`；扩展不持有 Atlas 凭据，只向 `127.0.0.1:43119` 的 Lumio bridge 发送标题、canonical URL 与 Markdown。正文先写入内容寻址的 extraction Artifact，再触发 `web.summary@1`，由 AtlasRunner 生成 summary Resource。
- Pi 会在 Atlas 注册成功后自动 reconciliation：读取全部 summary Resource，校验 Artifact hash，投影 `pending`/`reviewed` 卡片，并移除 `dismissed` 卡片。内容无变化时不会改写文件。
- `/atlas:reconcile`：手动执行同一套全量 reconciliation，并报告 created、updated、removed、unchanged 和 failed 数量。
- `/atlas:comment <resource_id>`：本地创建稳定路径的空白 `Knowledge/Comments/<resource_id>.md`，连续打开 Resource 与 Comment；此时 Resource 仍为 `pending`。
- `/atlas:complete-comment <resource_id>`：人工写完后读取并校验本地 Markdown，上传到 Atlas；Atlas 原子保存 Comment 与 KnowledgeRef、将 Resource 标为 `reviewed`，再刷新卡片状态。
- Atlas Console 的 `写评论` 直接通过 Obsidian URI 本地创建并打开草稿；`完成评论` 排队 `vortex-comment-sync-v1`，由在线 Lumio 读取本地草稿并同步到 Atlas。
- `/atlas:dismiss <resource_id>`：将没有 KnowledgeRef 的 Resource 标为 `dismissed`，并只删除可重建的 Resource Card。
- `/atlas:restore <resource_id>`：将 dismissed Resource 恢复为 `pending`，并重建 Resource Card。
- `/atlas:digest` 与 `/atlas:audit`：生成可重建的每日审阅简报和每周完整性检查；成功连接 Atlas 时会自动刷新当天简报，周日同时刷新 Audit。
- `/atlas:compare <resource_id>`：显式排队观点对比；只读取 Atlas 中同 Resource/同 Source 的已完成评论，以结构化数据生成“来源观点 / 我的观点 / 对比判断”Obsidian callout 卡片，不修改人工 Knowledge。Console 会提供“查看对比”直达入口。

summary Resource 的 `metadata.profile_id` 表示分析目的。同一 Source 与 profile 只投影当前结果；不同 profile 并列存在。被 KnowledgeRef 引用的历史 Resource Card 会保留，避免破坏人工证据链接。

`Resources/**` 是机器生成的投影，可以重建；`Knowledge/**` 是本人写评论与查看观点的本地平面，reconciliation、dismiss 和 restore 都不会覆盖或删除它。完成后的 Comment 以 Atlas 为事实源；摘要正文、transcript 和网页 extraction 不进入 Atlas SQLite，也不进入 Run output。

网页采集 bridge 默认只监听 loopback 的 `43119` 端口，只接受 Chrome extension origin、JSON 和专用 capture header。可用 `LUMIO_WEB_CAPTURE_PORT` 改端口；修改后也要同步更新扩展的 `BRIDGE_URL` 与 `host_permissions`。

## 迁移来源

需要的 `@diegopetrucci/pi-extensions` 功能已按 Lumio 原则拆分、本地化到 `extensions/`，不再把该第三方插件作为运行时依赖。Lumio 不保存 upstream 源码快照；`npm run check` 通过 GitHub compare 和 `upstreams.json` 中的显式路径映射监控相关更新。

## 维护约定

- 不把第三方 pi 插件加入本项目运行时依赖。
- 需要外部功能时，先研究其实现，再在 Lumio 内按需重写。
- 保持每个功能独立、轻量、可删除。
- 不维护通用 Todo：Plan mode 的步骤只服务于当前会话，持久可执行事项以后由 Atlas WorkItem 负责。
