# Agent Note: Driver 无关的会话运行时与工作状态投影

Status: implemented

[English](2026-08-23-driver-neutral-session-runtime-and-work-state.md) | 中文

## 问题

`AgentStatus = 'idle' | 'running'` 能正确回答一个已发布 agent 是否完全停稳，但 Agent Driver（智能体驱动器）在发布前以及等待人工注意时也具有状态。持久会话可以在没有存活 agent 时处于 cold 或 unavailable，批准与用户输入请求也可以和运行中的工作共存。提供方原生 Objective、Checklist（检查清单）和已完成计划文档也不共享 DSH Goal 或 Plan Mode 的身份与变更语义。

让 `AgentStatus`、`goal/change` 或 `plan/mode` 承担这些含义会迫使现有消费方解释无关状态，并虚构提供方并不具备的通用执行语义。第二套持久投影框架则会重复 [会话投影与命令生命周期日志](../../proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)及其已经交付的 [Host 状态／客户端视图分离](2026-08-19-session-projection-state-and-client-views.zh.md)。

## 决策

### 二值 agent 活动状态保持不变

`AgentStatus` 仍然严格为 `idle | running`，并继续作为已发布 agent 的完成与完全停稳信号。等待批准或用户输入不会使运行中的工作变为 idle。没有存活 agent 的持久会话不具有合成的 agent 状态，也不会发布占位 agent。

### 进程本地会话运行时状态

`SessionRuntimeStatus` 是进程本地的当前值服务，而不是会话日志投影。它报告不可变的会话与 Driver id、可用性（`cold`、`activating`、`available` 或 `unavailable`）、agent 可用时的可选二值活动状态、当前通用 operation、Driver 所拥有的诊断详情，以及彼此独立的待处理批准和用户输入计数。

Driver 激活与注意力贡献均受 effect 作用域约束。独立贡献方会被计数，而不是压缩成一个布尔值，因此批准与用户输入请求可以共存。运行时 revision 用于排列当前 Host 观测值，但不会在重启后回放；回放连接尝试或陈旧注意力会虚报当前进程状态。

### 静态 Agent Driver 事件

Core 静态声明持久外层事件族：`agent-driver/activation`、`agent-driver/model-request`、`agent-driver/model-attempt`、`agent-driver/activity`、`agent-driver/objective`、`agent-driver/proposed-plan` 和 `agent-driver/checkpoint`。Driver 所拥有的嵌套判别字段保持开放并携带无损 JSON，而已知外层用途在所属 Driver 缺失时仍保留通用回放、后备渲染和兼容性检查。

未知的必需外层事件会以安全方式拒绝读取。Driver 的模型可见请求事件记录重建所需的确切消息、图像、工具、指令、已解析模型调用配置和已捕获重试策略。原生命令、文件变更、差异、推理（reasoning）摘要和状态仍属于 Driver 活动；只有确实通过 `ctx.tools` 运行时才成为 DSH `tool/*` 事件。

### 可移植工作状态投影

`agent-driver/objective` 携带 Driver 无关的完整 Objective 快照，其中包含显式执行所有者、文本、规范化阶段、可选预算、注意力或停止原因以及不透明路由数据。它不会虚构 DSH Goal id、revision、CAS、Round 预算或续行规则。DSH Objective 适配器从权威 DSH Goal 领域派生相同的可移植视图，而不重复 `goal/change`。

可移植 Checklist 继续使用现有整表 `todo/write` 事件和 `TodoItem` 术语。投影生产与面向模型的 `todo_write` 消费方分离，因此原生 Driver 可以发布规范化的 `pending`、`in_progress` 和 `completed` 项目，同时保留唯一变更所有权。

`agent-driver/proposed-plan` 携带具有自身身份与生命周期的持久已完成计划文档。Proposed Plan 与 Checklist 进度和 DSH Plan Mode 均相互独立。本决策不包含通用原生协作模式控制，也不包含原生协作模式 Web UI。

### Host、SDK 与 Web 投影

现有会话载体公开不可变 Driver id、当前运行时状态和已注册的持久投影值。TypeScript 与 Python SDK 的完成行为继续基于二值 `session.status`；运行时可用性是独立值，unavailable 会话会使所拥有等待显式失败，而不会被视为 idle。

Web 支持没有存活 agent 的持久会话，并通过会话作用域存储和已注册对话节点渲染 Driver 选择、运行时可用性与注意力、Driver 活动、Objective、Checklist 和 Proposed Plan。

## 考虑过的替代方案

**将提供方状态加入 `AgentStatus`。** 激活可以先于 agent 发布，注意力可以与 running 共存，Objective 阶段也不是整体 agent 活动状态。一个联合类型无法保留这些独立含义。

**持久化每次运行时转换。** 回放旧 connecting 或 waiting 值会虚报当前 Host。只有持久来源、请求、尝试、活动、工作状态和检查点属于会话日志。

**为每个 Driver 使用 `goal/change`。** 原生 Objective API 不一定公开 DSH 身份、revision、Round 准入或续行语义。虚构这些字段会产生不安全的并发预期。

**在原生执行旁挂载 DSH Goal、plan 和 todo 变更。** 两个所有者会竞相修改名称相似但语义不同的值。每个会话对每个支持控制的领域只有一个执行所有者。

**将已完成计划作为 Checklist 文本或 Plan Mode。** 具有审查生命周期的文档既不是任务状态列表，也不是协作模式选择。

**创建另一套 Driver 投影框架。** 现有会话投影注册表已经负责持久折叠和客户端视图；只有瞬时运行时状态需要独立的进程本地服务。

## 后果

通用消费方可以区分持久性、可用性、活动、注意力和可移植工作状态，而无需了解 Driver 协议。Driver 卸载可能使执行不可用，但不会使同版本的已知外层事件无法读取。开放的嵌套 Driver 数据需要有界载荷和后备展示，而调度与完成行为会忽略这些数据。

可移植投影有意公开少于提供方原生状态的控制能力。身份、变更、记账、并发和续行仍由所选执行所有者负责。协作模式集成需要独立的已交付控制与 UI 决策，不能由 Proposed Plan 支持暗示。

## 验证

Core 与包测试固定未变化的二值 `AgentStatus`、cold／activating／available／unavailable 运行时值、独立注意力计数、effect 释放、不可变 Driver 匹配、静态事件验证、未知必需事件失败、确切模型请求重建、Objective 所有权、可移植 Checklist 折叠、Proposed Plan 投影、Host 载体、SDK 运行时观测以及 Web 运行时／活动／工作状态渲染。
