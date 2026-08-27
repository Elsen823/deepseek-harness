# Agent Note: 会话绑定的 Agent Driver 注册表

Status: implemented

[English](2026-08-23-session-bound-agent-driver-registry.md) | 中文

## 问题

`ctx.agents` 过去通过一个组合级实现委托所有创建与恢复操作。该机制可以为整个部署替换默认 agent loop（智能体循环），但不能让多个一等执行实现作为持久的逐会话选项同时可用。恢复后的会话也缺少持久字段来证明哪个实现拥有其历史记录。

现有所有权决策仍是关键约定。`AgentHandle` 的 dispose（资源释放）和有序的 agent/会话发布由 [agent 生命周期与所有权约定](2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)负责，二值 `AgentStatus` 由 [可观测 agent-loop 状态机](../simplification/2026-07-24-agent-loop-observable-state-machine.zh.md)负责。Driver 选择扩展而不替换这些决策。

## 决策

### 不可变 Driver 绑定

每个 `SessionHeader` 都包含必填且品牌化的 `driverId`。该值在会话内不可变，并由持久化、查询、Host、Web 和两个 SDK 投影携带。新建会话使用显式选择的 Driver 或注册表默认值；恢复只选择持久化 header 中记录的 Driver。注册缺失时会失败，而不会推断另一个 Driver。

内置 Driver id 为 `dsh`，由现有 DSH agent loop 支持。Driver 身份与 [逐会话 agent preset](2026-08-03-per-session-agent-presets.zh.md)保持独立：Driver 选择执行实现，preset 选择该会话的作用域组合。更换执行实现需要创建不同的会话或 fork，并且不会重写源绑定。

Web 创建控件只出现在 New Session Hero 中。它在连接或创建空白 Session 时一并提交所选 Driver 与 Workspace；活跃 Session 的控件不能更改绑定，也不能发起隐式 fork。编程式 fork 仍是独立且显式的 Session 操作（[决策](../bug-fix/2026-08-24-new-session-driver-workspace-pair.zh.md)）。

### effect 作用域的具名世代

`AgentRegistry` 按 `AgentDriverId` 存储具名 `AgentDriver` 注册。每项注册都是可逆的 Cordis effect，并代表一个确切的提供方世代。释放该世代会中止未发布的准备工作、停止并排空它创建的所有存活 agent，并在注册消失前等待生命周期包装操作结算。同一组合中的其他 Driver 可以继续保持注册和活跃。

Driver 发布不可变的发现元数据，并实现一个通用 `prepare(session, options, signal)` 操作。准备结果包含未发布的 agent 以及窄化的 `start` 和 `dispose` 钩子；产品专属生命周期方法不会进入注册表 API。

Core 会传递带 source 标记的 `UserMessage` 内容，而不解释提供方原生 command、skill、mention 或 prompt 语义。每个 Driver 在自身 Agent 实现内部拥有原生结构化输入扩展。

### 未发布准备与发布事务

注册表拥有通用创建／恢复事务。它准备或恢复会话、选择已绑定 Driver、等待 Driver 准备和作用域设置、运行同步设置提交，随后才发布会话和 agent 并开始执行。失败、取消、所有者释放或 Driver 卸载会回滚未发布工作，不公开任何注册表条目。

注册表仍是防止重复存活会话、规定发布顺序、分离注册表条目以及最终会话 flush 顺序的唯一所有者。每个 Driver 通过返回的钩子拥有其私有连接、执行、取消、完全停稳和已准备作用域清理。

### 运行时与工作状态依赖

Driver 绑定不会重新定义整体 agent 完全停稳，也不会创建共享的提供方原生 Goal 状态机。[Driver 无关的会话运行时与工作状态投影](2026-08-23-driver-neutral-session-runtime-and-work-state.zh.md)负责进程本地可用性和注意力，以及以此不可变 Driver 身份为键的可移植持久投影。

进程替换使用独立的通用[进程代际重启交接](2026-08-26-process-generation-restart-handoff.zh.md)。Driver 可以提供 `PreparedAgentDriver.handoff()` 来实现有界停稳和不释放的采用；普通提供方卸载与 `AgentHandle.dispose()` 仍是唯一调用 `dispose()` 并发出释放生命周期边的路径。

## 考虑过的替代方案

**每个组合使用一个 agent 工厂。** 这会使替代实现成为部署级替换，无法在恢复时保留逐会话执行选项。

**在 `dsh-agent-loop` 内部分支。** 这会让默认循环拥有无关的执行引擎、原生协议和外部进程生命周期。具名 Driver 使内置循环保持独立。

**将 Driver 选项编码为 agent preset。** preset 选择作用域组合，而不是不可变执行所有权或原生恢复兼容性。这两个 header 字段具有不同含义和生命周期。

**复用 subagent 注册表。** subagent 提供方拥有委派的子任务或对话，而不拥有父会话的执行、Web 对话或恢复绑定。

## 后果

一个组合可以托管多个 Driver 世代，而每个会话恰好只有一个持久执行所有者。必填 header 字段会有意使旧生产方或部分完成的生产方失败，直到它们写入有效 Driver id。提供方卸载属于生命周期事件：受影响的存活 agent 会排空并分离，而不会静默迁移到另一个 Driver。

Driver 作者获得更小的公开 API，但必须满足注册表的准备、取消、回滚、完全停稳和释放义务。产品专属控制保留在 Driver 所拥有的服务与投影中，而不会在 `AgentDriver` 上累积可选方法。

## 验证

核心生命周期测试覆盖具名注册、重复 id、默认 `dsh` 选择、仅依据持久化记录恢复、未发布回滚、同 id 竞态、所有者与提供方卸载、取消、完全停稳后的释放、发布顺序和会话 flush 顺序。持久化、查询、Host、TypeScript SDK、Python SDK 与 Web 测试固定必填且不可变的 `driverId` 在各自载体中的传递。
