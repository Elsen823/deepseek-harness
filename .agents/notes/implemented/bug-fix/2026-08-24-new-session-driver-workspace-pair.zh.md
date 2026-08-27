# Agent Note: New Session 的 Driver 与 Workspace 选择物化为一个不可变 Session

Status: implemented

[English](2026-08-24-new-session-driver-workspace-pair.md) | 中文

## 问题

如果把 Agent Driver（智能体驱动器）选择器挂在会话作用域的 composer 中，它会在对话开始后仍然出现，但 `SessionHeader.driverId` 不可变。把该控件当作切换器，就必须在类似设置的交互背后替换当前空白 Session，或对已有内容的 Session 执行 fork，而控件并未表明 Session 身份会发生变化。

Driver 与 Workspace 选择还需要共享一次物化决策。若只按 cwd 创建替代空白 Session，就会丢失 Workspace 成员关系；后续 Workspace 连接若不携带 `driverId`，则会复用或创建 Host 默认 Driver。两种选择顺序因而得到不同结果。原生 `<select>` 还会带来展示问题，因为其操作系统弹层无法可靠继承 Web 暗色主题。

## 决策

[不可变 Driver 绑定](../architecture/2026-08-23-session-bound-agent-driver-registry.zh.md)仍是创建事实。ui-conversation 在 `conversation.hero.workspace` 旁声明根作用域 `conversation.hero.agentDriver` slot；`ConversationRoot` 只在无会话或空白会话的 Hero 中渲染两者，并向 Driver 贡献项提供 `{ selectedDriverId?, selectDriver }`。

`ConversationRoot` 在本地暂存尚未物化的 Driver 选择。选择 Workspace 时调用 `selectWorkspace(workspaceId, { driverId })`；已有 Workspace 时选择 Driver，也针对该 Workspace 调用同一操作。Host 发布所得空白 Session 后，其摘要中的 `driverId` 成为显示权威。活跃 composer 没有 Driver slot，创建控件也绝不调用 `sessions.fork()`。

`WorkspaceRuntime.connectWorkspace(workspaceId, options?)` 拥有组合决策。提供 `options.driverId` 时，空白复用同时要求 Workspace 成员关系、规范 cwd 相等与 Driver 绑定一致。未命中则调用 `session.create({ workspaceId, driverId })`，进行中的尝试按 Workspace 与 Driver 组合合并。既有同步可寻址保证仍允许 ui-conversation 在打开返回的 Session 前搬运草稿（[New Session 所有权](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)）。

外部 Codex Driver 贡献项渲染 `ui-primitives` 提供的共享 `Menu` 原语。触发器与菜单使用主题 token，控件只包含所选 Driver 名称与箭头，不包含无法解释的缩写或 fork 模式文案。

## 验证

客户端 runtime 与 conversation spec 固定两种选择顺序、Driver 感知的复用与创建、按组合键合并，以及根作用域 Hero slot。外部包构建把 `ui-primitives` 保持为共享 Client 模块，其打包后的浏览器产物包含 Hero 注册，且不含原生选择器、缩写或 fork 文案。默认 Web 组合没有第三方 Driver 选择器，因此产品可见证据来自已安装插件的浏览器运行，而不是默认组合的无密钥快照。

## 考虑过的替代方案

**保留会话作用域 Driver 切换器，并对已有内容的 Session 执行 fork。** 这会把改变身份的操作表现为设置，在绑定固定后仍显示控件，并可能在没有显式 Session 操作的情况下 fork 现有工作。

**让每个外部 Driver 插件直接创建或选择 Session。** 这会在所属的 runtime 与 conversation 包之外重复 Workspace 成员关系、空白复用、草稿搬运和当前 Session 编排。

**保留原生 select 并增加暗色 option 颜色。** 原生弹层由平台渲染，不能持续遵守 option 样式。共享 Menu 已拥有带主题的浏览器渲染、焦点、选择与 portal 放置。

## 后果

先选 Driver 或先选 Workspace 都会产生相同的 Session 绑定与成员关系，活跃对话也不会暗示其不可变 Driver 已改变。为既有空白 Session 选择另一个 Driver 时，旧空白 Session 可能留在列表镜像中并被隐藏；这与既有 Workspace 切换残留一致，也允许以后按组合精确复用。Driver 发现与展示仍由外部插件负责，ui-conversation 与 WorkspaceRuntime 则拥有物化过程。
