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
├── skills/       # pi skills
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
- Gnosis、Librarian、Oracle、review、triage、todo、questionnaire 和 workflow audit 等本地工具与命令。
- Bark 与桌面/终端完成通知。

## 迁移来源

需要的 `@diegopetrucci/pi-extensions` 功能已按 Lumio 原则拆分、本地化到 `extensions/`，不再把该第三方插件作为运行时依赖。Lumio 不保存 upstream 源码快照；`npm run check` 通过 GitHub compare 和 `upstreams.json` 中的显式路径映射监控相关更新。

## 维护约定

- 不把第三方 pi 插件加入本项目运行时依赖。
- 需要外部功能时，先研究其实现，再在 Lumio 内按需重写。
- 保持每个功能独立、轻量、可删除。
