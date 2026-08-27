# Agent Note: Claude Agent Driver 原生所有权

Status: implemented

[English](2026-08-25-claude-agent-driver-native-ownership.md) | 中文

## 问题

Agent Driver 注册表必须证明第二种执行实现可以拥有持久化 Session，同时不向 core 增加产品专属分支，也不让 DSH 负责另一个 CLI 的原生策略。

## 决策

`@deepseek-ai/dsh-claude-agent-driver` 是位于 core 之外的可选 provider 包。它通过共享的 `AgentRegistry` 注册表机制注册 Claude Driver 与不透明的 `claude-code-settings` contribution；core 只保存并释放该 contribution，不解释 Claude 字段，保留的 Grok id 仍然是空白适配器。

Claude Code 负责 instructions、skills、tools、hooks、approvals、权限与执行。provider 将直接文本 Chat 输入发送给 Claude Agent SDK，把可表示的 DSH provider／model／effort 选择映射到原生值；遇到不支持的值时抛出 `ClaudeModelSelectionError`，其中包含被拒绝的选择和明确的不兼容原因。通用 activation、model-request、attempt、activity、checkpoint、assistant-message 与 turn 事件保留可重建的 DSH 时间线，但不复制原始原生协议载荷。

provider 每次只以文本 prompt 模式打开 Claude Query 并运行一个原生 turn，因此不会使用 SDK `streamInput()`。`steer()` 会明确地把直接用户消息排入下一个 DSH/native turn；活动中的原生 query 会继续运行，一条排队的 steering message 会准确投递一次，且不会留在 `next-step` inbox 中。

provider 将 Claude 带品牌的原生 conversation id 保留为 Driver provenance。恢复时将该 id 通过 SDK 的 `resume` 选项传入；`observeClaudeSession()` 只从 Session 日志派生 identity、activity 数量和 cold／active 状态，不激活也不发 query。model-request 事件在调用 `query()` 之前记录准确的直接 prompt 与可序列化原生选项，并列出 SDK 无法暴露的原生 instruction、skill、tool 与 hook 输入。可选的原生 approval、elicitation 与 user-dialog callback 贡献 runtime attention 计数，但不改变其原生决定。Host runtime status 携带不可变的 Claude Driver id、二值 Agent activity、可用性、attention 计数与原生 activation 细节。

对于从生命周期派生的 conversation identity，client 的 model-selection projection 会读取 `agent-driver/activation` 与 `agent-driver/checkpoint` 事件上通用的 `provenance.nativeConversationId` 字段。这样，首个原生 turn 的 checkpoint 被记录后即可识别，无需在 Driver payload 中增加 Claude 专属的 conversation 字段；Selected、Effective、Native、DSH Session、status 与只读 Activity 仍保持为独立 projection。

浏览器包通过 agent-neutral 的 conversation registry 与 view slot 提供只读的设置与管理入口以及 `Driver Activity` conversation 标签页。Claude provider 和 UI 行通过专用 Profile 或测试／示例 overlay 加载；随包交付的 Web bundle 不加载这两个可选包。离线 overlay 使用 `permissionMode: dontAsk`，且不提供原生 interaction callback，因此真实 attention visualization 仍需手动检查；focused callback 测试覆盖桥接，但不添加生产环境的 synthetic attention hook。

## 考虑过的替代方案

**在 core 或 `dsh-agent-loop` 内部分支。** 这会让默认执行包负责 Claude 协议和进程策略。具名 provider 使 core 保持与 agent 无关，并让每个 Driver 拥有自己的原生生命周期。

**向 Claude 注入 DSH prompt、tool 或 approval 上下文。** 这会产生两个相互竞争的策略所有者，并使原生 Claude 行为依赖 DSH prompt 词汇。直接 Chat 仍是 DSH 唯一编写的模型输入，Claude 继续保留自己的原生能力。

**在 Web 默认值中交付 Claude。** 这会让每个无密钥 Web 部署都带上可选 SDK 与原生 provider。显式 overlay 保持默认依赖与组合闭包不绑定具体 provider。

**推断不支持的选择或原生 identity。** 静默回退会改变请求的 route，或声称 provider 无法证明的会话连续性。mapper 明确拒绝不兼容项，observation 只读取已记录的 provenance。

**声称能够完整重建原生 prompt 内部。** Claude SDK 不暴露最终的 instructions、skills、tools 或 hook 扩展 prompt。provider 记录准确的直接 prompt 与生效的 adapter 选项，并明确列出这些不可用输入，同时将其所有权留给 Claude。

**使用 SDK streaming input 处理 DSH steering。** provider 的文本 prompt 模式没有向 DSH steering 提供可靠的原生 step 边界。把 steering 排入下一个原生 turn 可以保持 Claude 的执行所有权，并为 DSH inbox 提供一个持久化的投递边界。

## 后果

Claude 设置消费者可以在不扩展 core 的情况下演进自己的不透明 contribution。DSH 可以在 Chat 与 Driver Activity 中渲染原生最终答案和有界 activity 摘要，而原生 instructions、tools、approvals 与执行仍在 DSH transcript 之外。非文本 Chat block、完整原生 prompt 重建和原始协议 activity 仍不支持，并在包限制中明确说明；可选的 SDK interaction callback 可以暴露等待中的 attention，但不改变原生决定。

## 验证

Provider 测试覆盖注册释放、直接 Chat、准确的 query 前 request snapshot、原生 identity 与 activity、明确的模型不兼容、取消、maintenance quiescence、initiator 作用域、原生 interaction attention、resume 选项和活动 query 中的 steering 投递。assembled Web snapshot 只通过测试 overlay 加载可选 UI。无密钥 Chromium fixture 绑定 `driverId: claude`，证明首个 turn 从缺少 id 到 checkpoint identity 的转变，渲染 Selected、Effective、Native 与 DSH Session identity、status 以及只读 Driver Activity 标签页，保留 activity 与 checkpoint provenance，在不追加事件的情况下观察 live Session，并检查恢复后的原生 identity 与 request continuity。干净的真实模型 GIF 与真实 attention visualization 仍是手动证据。
