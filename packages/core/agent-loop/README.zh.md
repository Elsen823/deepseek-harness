# dsh-agent-loop

[English](README.md) | 中文

内置 `dsh` Agent Driver 适配器。其包私有 `ReactLoopAgent` 满足通用 `Agent` 接口，并驱动 DSH 的会话、轮次和步骤执行模型。

本包只拥有 DSH 循环行为和声明式 DSH agent 启动。`AgentRegistry` 拥有通用 Driver 选择、Session 准备、未发布 setup、发布、回滚、调用方／提供方所有权和有序 teardown，因此其他注册 Driver 可以共存，而无需在此循环中分支。

## 服务：`AgentLoop`（ctx 键：`agentLoop`）

### 公开 API

包私有 Driver 适配器使用稳定 id `dsh` 和不可变发现名称 `DeepSeek Harness` 注册到 `ctx.agents`。它构造未发布 `ReactLoopAgent`、验证 DSH `AgentOptions`，并拥有执行与作用域钩子。`AgentLoop` 只公开声明式启动策略和 `create()` 辅助方法；未发布 prepare 钩子不属于 `ctx.agentLoop`。

- `ctx.agentLoop.create(id, options?, meta?): Promise<Agent>`：DSH 专用便捷方法，委派到 `ctx.agents.create({ driverId: 'dsh', ... })` 并返回已发布 Agent。
- `ctx.agents.create(...)` 和 `ctx.agents.resume(...)` 是 Driver 中立的所有权生命周期操作。Resume 读取已存 Session Driver 绑定，因此由其他 Driver 创建的 Session 不会仅因 `dsh` 是部署默认值而由本适配器解释。

配置行属于 DSH 启动策略。新建行显式选择 `dsh`；存在持久化且配置稳定 `sessionId` 时先尝试 resume，仅在工件缺失时新建。提供方卸载由注册表中的确切 Driver 代际跟踪，并在该 effect 结算前排空本适配器准备的所有 Agent。

### 注入的服务

`agents`、`sessions`、`llm`、`tools`、`systemPrompt`：全部 5 个接口服务。

### 不变量配套入口

可选的 `@deepseek-ai/dsh-agent-loop/invariant` 配套入口会向 `ctx.invariants` 注册请求重建。循环会把每个确切的冻结请求记录在 `dsh-llm` 拥有的进程本地身份集合中；随后，配套入口要求存在实时会话，并根据日志独立重建消息边界和折叠后的请求 header。即使调用方冻结直接的一次性调用，或为其附加会话 id，这类调用仍不属于该约定。

### 配置（Schemastery）

```ts
interface Config {
  maxParallelToolCalls?: number // default 10; 1 is serial
  agents: Array<{
    id: string                 // required
    provider?: string
    model?: string
    maxTokens?: number         // positive per-request output-token cap
    resumeSessionId?: string   // load this persisted session instead of creating one
    cwd?: string               // optional workspace cwd for the fresh session
  }>
}
```

通过配置创建的 agent 会自动启动。每个 Agent 都携带一个 Session 局部 Model Selection；模型调用必须有其 provider 与 model，缺失路由会在提示词组装和模型 I/O 之前失败。可选的正数 `maxTokens` 会为每次对话请求提供初始输出上限，并记录在请求 header 中。`maxParallelToolCalls` 限制每个 agent 针对并行安全调用使用的滚动池，默认值为 `10`；它同时也是 `agent-loop` Settings 段的全部内容，因此叠加在该条目之上的用户层无需重启即可限制下一组工具调用，而非正整数的值会在写入时被拒绝，而不是到那一组时才失败。`agents` 刻意不在该段中——它在服务启动时被消费一次，所以存储的改动只会看起来生效。`cwd` 仅应用于全新会话，而 `resumeSessionId` 保留持久化元数据。通过配置创建的 agent 使用部署 persona；编程式 setup 可以按 agent 遮蔽它。该插件为每个 Turn 提供 `provider`、`model` 提示词变量以及 `cwd` 变量；harness 身份与部署 persona 属于 `dsh-system-prompt`。

### 包内部具体驱动器

具体 `ReactLoopAgent`、其 inbox 与运行控制均为包内部实现。包根只导出插件／服务／配置约定，包导出映射不提供 `./src/*` 逃逸路径；生命周期拥有方通过 `ctx.agents` 创建 agent，而不是点名、构造或启动驱动器内部组件。一个准备完成的会话只能由一个具体驱动器认领；所有可观测行为都通过会话事件和 `agent/*` 事件分类体系发生。

统一的 `send()` 原语按（`target` × `wakeup`）路由内容与来源；`followup`/`steer`/`inject` 是它的固定预设别名。`followup()` 追加到 `next-turn` FIFO 并唤醒驱动器，`steer()` 追加到 `next-step` inbox 并唤醒驱动器，`inject()` 则追加到同一个 `next-step` inbox，但不唤醒驱动器。在轮次边界，驱动器会先打开持久轮次，再原子领取待处理的 next-step 输入和一条排队提示词；在步骤之间则只领取 next-step 输入。领取操作通过仅执行删除的 splice 移除整批消息，并为每条消息各发出一次 `agent/inbox/claimed { message, turn }`。随后 `agent/pre-step` 返回拒绝结果，或返回将进入拟议步骤的完整消息。拒绝后，已领取批次保持已删除，并关闭不含步骤的轮次；领取后插入的输入仍等待后续处理，而空闲注入会一直等待，直到 follow-up 或 steering 唤醒驱动器。

每次 inbox 变更都会在修改实时投影之前，先发布一条规范化的 `agent/inbox/spliced` 事件。因此，插入、编辑、移除、领取与取消都通过同一组标准 splice 坐标回放。普通删除携带 `outcome: 'canceled'` 并发出 `agent/inbox/discarded { message }`；领取使用不带 outcome 的纯删除，随后由循环发出 `agent/inbox/claimed`。每次插入都会发出 `agent/inbox/inserted { message }`。`MessageId` 在两个待处理列表之间保持唯一，持久事件的同步观察方可以从 splice 前投影重建被移除的值。

### 循环生命周期（`agent.ts`）

驱动器在其整个生命周期内拥有一个 agent，并在 `ctx.agents.withInitiator(agent, ...)` 内运行。包私有的编排入口点会恢复确切的 Agent，一次性派生 `agent.session`，并让操作局部的辅助函数捕获它，而不是通过浅层接口继续传递具体驱动器或每次操作的 `Session`。如果显式 `Session` 正是辅助函数的实际接口，该辅助函数会保留它；创建、持久化加载、未发布 setup、服务、worker、进程、持久化和 wire 协议则继续保留各自的显式身份。[agent 服务](../agent/README.zh.md#initiating-agent-scope)规定传播、teardown 和分离工作规则。

每次提供方调用成功结束时，都会恰好追加一个 `assistant/message` 完成锚点，包括无内容调用和以 `max-tokens` 结束的调用。该锚点原样记录组装后的内容，在 `sourceEventSeqs` 中列出确切的分片 seq（流没有分片时为 `[]`），并在用量可用时包含用量；空内容不会进入派生消息历史。轮次取消打断流式输出时，如果非空文本或推理内容已送达用户，循环也会追加一个带 `interrupted: true` 的锚点。该锚点引用对应的分片 seq，并把已渲染的前缀放入派生消息历史，使下一次请求包含用户看到的内容。未分派的工具调用会被省略，空流或只包含工具调用的流不会生成锚点；提供方故障也不提交 assistant 内容（[决策](../../../.agents/notes/implemented/architecture/2026-08-10-cancelled-stream-prefix-finalize.zh.md)）。

内置 DSH Driver 会在首个 prompt 被接纳后、提示词组装前捕获一个不可变的 Model Selection。该 Turn 的每个 step 和 retry 都使用同一个 provider/model 与已解析的 effort，因此 Turn 运行中接受的新选择只影响下一 Turn，而 steering 保持当前值。selected intent 会在首个请求前追加；即使准备好的 stream 随后失败或被取消，effective request header 仍会保留。选择省略 effort 时，精确模型当前的提供方默认值只在 Turn 开始时解析一次；路由不可用或 effort 不受支持会在模型 I/O 前失败，且不会改变 selected intent。

在 `agent/request` 返回调用配置后，循环会调用 `ctx.llm.prepareCall()`，在活跃轮次信号的控制下校验由适配器负责的字段，并填入输出 token 默认值。准备完成的调用会在这次异步解析、`request/header` 日志记录和最终分派期间保留同一项确切的适配器注册，因此 HMR（热模块替换）不会把某个适配器的能力解析结果与另一适配器的请求混用。请求 header 会记录生效配置以及哪些字段来自适配器。在每次请求之前，冻结的 Turn Model Selection 会恢复其 provider、model 与 reasoning effort，而 request middleware 仍负责无关的封套字段。没有已注册适配器的路由会在模型 I/O 之前失败；新的循环实例会从 Agent owner 解析下一 Turn。

插件失败会结束当前轮次，而不是结束循环。最终适配器选择、分发与迭代失败会以终止错误或中止结束的形式由 `ctx.llm` 传来，并进入 `agent/request-error`；middleware、结果处理、工具及其他扩展失败仍会抛出并直接关闭轮次。恢复逻辑会接收请求坐标、不可变的提供方事实、准备完成的适配器注册所捕获的不可变重试策略以及轮次信号；middleware 接管未准备路由时，该策略缺失。处理失败的监听器返回 `{ kind: 'retry' }`；未被处理的失败是终态。AgentLoop 为当前准入操作或轮次拥有一个取消信号。有效的 `cancel(cause)` 在未设置 `keepInbox` 时清除待处理工作，并以协作方式中止该信号；空闲取消是空操作。abort 触发后、活动收敛到空闲前到达的唤醒输入会被锁存（`wakeRequested`），并在 driver 自身的收敛边界重放，无需再发一条唤醒 send 即可执行；`disposed` 取消从不锁存，而 agent 已处于空闲时发送的唤醒总是打开自己的 turn 边界（即使消息已被清除，状态也会显示瞬态 `idle → running → idle` 对）。持久 `turn/end` 为 `user` 和 `parent` 记录 `aborted`，dispose 则记录 `disposed`；未分发的模型工具调用会收到合成的 `tool/call` 与 `ABORTED_BEFORE_DISPATCH` 结果对。取消原因只影响报告方式，不影响如何处理在取消后完成终结的结果上下文。dispose 会等待忽略信号的工作完成，然后才从注册表移除。[显式取消决策](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.zh.md)与[取消收敛窗口唤醒锁存](../../../.agents/notes/implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.zh.md)规定生命周期与竞态约定。

在步骤内，独占调用形成屏障；并行安全调用使用有界滚动池，并在启动前重新分类。只有分发和调用主体的执行会发生重叠。策略、持久结果和结果上下文仍保持模型顺序。中止会阻止启动新的调用，等待已启动调用的结果处理完毕，并保留其完成终结后的结果上下文，不区分取消原因。内部调度器故障会停止新的分发，等待已启动的分发，然后在不虚构工具结果的情况下到达轮次错误边界。

### 插件负责的内容

超出「调用模型、运行工具、重复」的所有内容，都属于监听事件分类体系的插件：
- 钩子与策略：相关的 `agent/*` 检查点，加上受守卫保护的 `tools/pre-execute` → `tools/execute` → `tools/post-execute` → 定义拥有的 `finalizeContent` → `tools/result` 流水线；确切事件签名与 mode 位于 [core.md](../../../docs/subsystems/core.zh.md#cordis-surface) 与 [tools.md](../../../docs/subsystems/tools.zh.md#cordis-surface) 的生成区块
- 压缩（compaction）：在 `agent/pre-step` 上观测压力；在 `agent/request-error` 上进行规范的溢出修复
- 模型请求恢复：`dsh-llm-retry` 在 `agent/request-error` 上记录并等待针对确切提供方配置的 normal 或无界退避，发出不进入表层的 `llm/retry` 状态，然后返回重试动作
- 沙箱、权限、计划模式：使用 `tools/pre-execute` 提供可扩展的拒绝／询问，使用 `tools.guard()` 提供单调拥有方策略，使用 `tools/post-execute` 处理结果决定，并使用 `tools/result` 进行最终观测
- subagent：在循环外部实现为 `ctx.subagents` 提供方；进程内提供方使用 `ctx.agents.create()` 创建 agent，并通过其拥有的 `AgentHandle` 执行 teardown，而通用的 [`ctx.jobs`](../../jobs/jobs/) 与 [`dsh-tool-subagent`](../../subagent/tool-subagent/) 负责后台收集。
- 持久化：`session/event` 发生后立即安排延后写入；`session/flush` 是显式观测屏障
- UI：`session/event`（assistant token 流、边界、工具活动）+ `agent/*` 控制事件（`agent/status`、`agent/created`/`agent/disposed`）

## 模型体验

### 完整对话请求

#### 模型看到的内容

每个步骤中，循环会发送针对该 agent 呈现的系统提示词、可见工具 schema 和会话派生消息。它提供 `provider`、`model` 与 `cwd` 变量值，但不添加固定文案。

#### Token 影响

每个步骤都会再次计入系统文本与 schema。逐 agent 作用域决定贡献，而权威组装 waterfall 可以改变最终请求，并使其监听器负责保持协议连贯。

#### KV Cache 影响

只有在同一提供方和模型路由下，且系统文本、schema 与此前历史都保持逐字节一致时，请求 token 序列才保持仅追加。携带 token 的组装改写或组合变更可能从第一个改变的请求 token 起使复用失效。

### 保留的消息历史

#### 模型看到的内容

已接纳的 user 消息、assistant 消息、工具调用与结果、注入上下文和 steering（中途引导）都会记录，并在后续步骤中发送。原始流分片、生命周期边界和其他仅写入日志的事件会被排除。

#### Token 影响

输入会随每条表层消息增长，直到压缩替换遮蔽较旧节点；包含多个步骤的工具轮次会在每个步骤重新发送累积的历史。

#### KV Cache 影响

普通历史增长仅追加，并保留可复用条目。表层替换或压缩会从第一个被遮蔽的历史 token 起使复用失效。

### 取消后未分发的调用

#### 模型看到的内容

如果后续请求回放一个中止的步骤，取消所阻止分发的每个工具调用都有错误码 `ABORTED_BEFORE_DISPATCH`，结果文本为 `Error: tool call aborted before dispatch`。

#### Token 影响

每个跳过的调用都会在历史中保留一个固定错误结果，直到压缩将其遮蔽。

#### KV Cache 影响

仅追加；每个合成结果都位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **分类是一元的**：安全性取决于比较同级调用或资源的调用必须保持独占（参见[设计原理](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.zh.md)）。
- **配置 label 默认对应新会话**：省略 `sessionId` 时，每次启动都会创建新的 `${id}-session-<uuid>`；如需确切的恢复或创建行为，必须显式提供稳定的 `sessionId`，而 `resumeSessionId` 要求已有持久化历史。
- **配置 agent 没有逐 agent persona 字段或 setup 钩子**：它们使用部署 persona；只有编程式 `ctx.agents.create()` / `resume()` 工厂选项支持带作用域的 persona／工具组合。
- **没有内置轮次预算**：工具调用或 steering 会让当前轮次继续；限制失控轮次的策略必须从既有生命周期扩展点（如 `agent/turn-stopping`）执行取消。
