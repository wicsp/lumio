# AGENTS.md

本项目是 **Lumio**：一个按个人真实需求维护的 pi extension / skill / prompt / theme 工具集合。

## 核心原则

- **只维护自己的 extension**：除 pi 本体外，不把第三方 pi 插件作为长期运行时依赖安装到本项目。
- **第三方包只作参考**：遇到有价值的功能时，阅读、理解、裁剪，然后复制必要思路或重新实现；不要直接依赖上游预制 harness。
- **保持简洁和可定制**：拒绝不需要的功能、重复功能、难以定制的功能，以及会把 Lumio 变成“另一个庞大预设框架”的实现。
- **最小依赖**：默认不添加 runtime dependencies。pi 核心包和 `typebox` 仅作为 peer dependencies 使用。
- **用户优先于通用性**：Lumio 面向个人工作流，不追求插件市场式的通用覆盖。

## 代码与资源组织

- `extensions/`：pi extension 入口和模块。
- `skills/`：个人技能说明。
- `prompts/`：个人 prompt templates。
- `themes/`：个人主题。
- `package.json`：pi package manifest，声明上述资源目录。

## 给编码代理的约束

1. 修改 pi API、extension、skill、prompt、theme 前，先阅读相关 pi 文档。
2. 不要为了“方便”安装第三方 pi 插件或把第三方插件加入 `dependencies`。
3. 如确需借鉴外部实现，先说明借鉴点，再在 Lumio 内实现一个更小、更可控的版本。
4. 新功能必须有明确个人用途；避免批量引入命令、工具或 UI 组件。
5. 发现重复功能时，优先合并或删除，而不是新增并行实现。
6. 工具输出必须控制长度，避免污染模型上下文。
7. 涉及文件写入的自定义工具应使用 pi 的文件变更队列机制，避免并行工具互相覆盖。

## 当前状态

`extensions/index.ts` 目前注册 `/lumio` 状态命令、Lumio permission gate、dirty repo guard、minimal footer、quiet tools，以及 Atlas RFC 0003 的 Source/Resource 执行与 Vortex Next 投影。`minimal-footer` 和 `quiet-tools` 已经本地化；其余从 `@diegopetrucci/pi-extensions` 迁入的功能已按用途打散到 `extensions/context/`、`extensions/knowledge/`、`extensions/review/` 等目录，后续应按个人使用习惯继续裁剪、合并或重写。通用 Todo extension 已删除；当前会话计划只由 Plan mode 管理，持久工作项以后由 Atlas WorkItem 管理。
