# Agent Note: 常驻 Codex 支持的会话

Status: implemented

[English](2026-08-23-resident-codex-backed-sessions.md) | 中文

## 问题

现有 Codex subagent 集成有意为一个委派任务启动一个全新产品进程、返回最终结果并终止该进程。此行为继续适合 [Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)，但无法让 Codex 成为持久 DSH 会话的执行实现，也无法提供恢复、流式活动、交互、取消和原生工作状态。

常驻集成还必须在 Codex 运行于 Host 时，让 DSH 中配置的模型 route 与凭据保留在 DSH。Codex app-server schema 和原生持久化具有版本专属性，因此激活过程必须证明确切受支持运行时，而不能把成功的 `thread/resume` 当作宽泛兼容性承诺。

主要来源约束和相邻版本证据仍记录在 [跨版本恢复报告](../../../research/codex-cross-version-resume.md)、[共享常驻服务报告](../../../research/codex-shared-app-server-remote-clients.md)和[原生 Goal 与 Plan 报告](../../../research/codex-goals-plans-dsh-integration.md)中。通用生命周期由 [会话绑定的 Agent Driver（智能体驱动器）](../architecture/2026-08-23-session-bound-agent-driver-registry.zh.md)负责，通用运行时与工作状态由 [Driver 无关的会话运行时与工作状态投影](../architecture/2026-08-23-driver-neutral-session-runtime-and-work-state.zh.md)负责。

## 决策

### 外部混合包与常驻守护进程

实现位于外部混合包 `@dsh-external/dsh-codex-agent-driver`，路径为 `/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver`，并包含 Host 与 Web 入口。它注册 `codex` Agent Driver、经过认证的 Responses Bridge、交互处理器、Driver 活动展示、Driver 选择、运行时展示和原生工作状态展示，而不会在内置 DSH 循环中增加 Codex 专属分支。

插件是官方常驻 Codex 守护进程的客户端，不拥有该守护进程。插件重载、Driver dispose（资源释放）、浏览器断开连接和 DSH 关闭会释放 DSH 连接与激活，但不会把守护进程视为 Cordis 子进程。运维设置、更新、回滚和 SSH 配置使用官方守护进程向导，而不是自定义 systemd 或 launchd 单元。

### 单一受信任 OS 与 `CODEX_HOME` 域

一个操作系统身份和一个 `CODEX_HOME` 构成一个完全受信任域。域内客户端共享文件系统权限、Codex 配置、原生 Thread 目录、提供方路由可达性和模型支出后果。激活凭据标识具有归属的 DSH 生命周期，并支持关联、记账、取消和撤销；它们不能让互相信任的客户端彼此隔离。更窄的信任需求使用独立操作系统身份和 `CODEX_HOME`。

远程人工使用通过 SSH 运行 Host 侧 Codex TUI。Orca 使用其远程终端与 SSH 工作流，而不充当 app-server 协议客户端。该集成不会把常驻守护进程公开为通用网络 WebSocket 服务。

### 确切的稳定 Codex 协议

该包支持兼容性 profile 所记录的确切 Codex `0.149.1` Host 与生成 schema 哈希。加载期准入会哈希配置的 CLI 与相邻可执行 `codex-code-mode-host`，读取正在运行的 daemon 描述，要求配置套接字上的托管 CLI 与 sidecar 字节一致，并在 sidecar 帮助、CLI 版本和 schema 检查期间证明所有可执行文件身份保持稳定。每个 Session 激活都会在连接前重新核验这些身份。它只使用稳定 API（`experimentalApi: false`），并通过仅所有者控制的 Unix socket 上的 WebSocket 通信。客户端方法和一等通知投影采用精确允许列表；未知服务器请求和未知模型可见项目会以安全方式失败，而有界的未知信息性通知保留为后备活动。

新 DSH 会话启动一个持久 Codex Thread。恢复使用 Agent Driver 激活与检查点事件中记录的原生 Thread id，并且只在确切发行组件准入和不订阅的 `thread/read` 身份检查后接受同版本状态。版本或 schema 不匹配、Thread 缺失、身份不符，或 read／resume 被拒绝时，都会记录显式重建，并仅根据经过净化的可移植 DSH 用户／assistant 文本和用户图片建立新 Thread；推理、旧命令、批准、原生工具、工具结果和副作用不会回放。

官方守护进程向导负责设置、版本更新、回滚和 SSH 指引。插件绝不执行隐式原生状态迁移，也不安装自己的服务管理器。

### 经过认证的 DSH Responses Bridge

Codex 获得一个逐激活 Responses 提供方，其经过认证的回环端点由插件 Host 托管。Bridge 通过 `ctx.llm` 解析并执行模型调用，因此提供方凭据和 Model Route 所有权保留在 DSH。回环来源不构成授权；每个 Bridge 请求都会检查基于命令的激活凭据，并在释放时移除该凭据。

Codex 的 `request_max_retries` 和 `stream_max_retries` 均为 `0`。Bridge 执行 DSH 捕获的重试策略，通过静态 Agent Driver 事件记录确切模型可见请求和每次尝试，流式传输受支持的 Responses 输出、报告用量并传播取消。不受支持的请求内容或 route 能力会在不安全的原生执行开始前失败。

### 会话、交互与工作状态映射

一个原生 Codex 轮次映射为一个 DSH Turn。已接受用户消息与最终 assistant 答案使用核心对话语义；原生命令、文件变更、差异、MCP 调用、推理（reasoning）摘要、状态、部分进度和错误使用 Driver 活动快照。批准与用户问题请求通过 DSH 交互服务路由、贡献彼此独立的运行时注意力计数，并且未知请求方法会以安全方式失败。

Codex 原生 Goal 快照投影为可移植 Objective，而不创建 DSH `goal/change`。稳定原生计划更新投影为可移植 Checklist，而不挂载 `todo_write`；已完成计划文档投影为 Proposed Plan。内置 DSH Goal、Plan Mode 和权限预设只拥有 `dsh` Session；跨 Driver fork 会省略其控制事件，composer 也会对备用 Driver 隐藏这些控件。已交付的 Web 集成提供 Driver 选择器、运行时徽标、活动视图、Objective dock、通过原生投影提供的 Checklist，以及 Proposed Plan dock。它不声称或渲染原生协作模式 UI。

## 考虑过的替代方案

**复用一次性 subagent 提供方。** 其全新进程与最终结果生命周期按设计不拥有持久父会话、交互式时间线或原生恢复。

**每个会话启动一个 app-server。** 这会放弃官方常驻守护进程模型、成倍增加进程与更新状态，并阻止受信任的 Host 侧 TUI 工作流共享同一个原生服务。

**让插件拥有常驻守护进程。** Cordis 释放要么终止运维方拥有的服务，要么留下无人拥有的进程。守护进程生命周期属于插件之外的官方运维工作流。

**安装自定义 systemd 或 launchd 单元。** 这会重复官方守护进程的设置、更新、回滚与 SSH 工作流，并创建第二个生命周期权威。

**声称一个守护进程内存在逐激活隔离。** 激活凭据提供归属与取消，但共享操作系统身份和 `CODEX_HOME` 仍保留共同原生权限。隔离需要不同的受信任域。

**模型调用直接使用 Codex 账户凭据。** 这会绕过 DSH Model Route、适配器、重试策略、用量所有权和凭据策略。Responses Bridge 使这些职责保留在 DSH。

**将成功的 `thread/resume` 视为跨版本证明。** 原生持久化可能被接受，同时记录被跳过或重新解释。确切同版本准入与显式重建避免作出这种不受支持的承诺。

**因为存在原生计划而公开原生协作模式。** Checklist 进度与已完成 Proposed Plan 已交付，但不存在原生协作模式控制与 Web UI。该集成不会从计划事件推断出此能力。

## 后果

Codex 支持的会话与内置 DSH 会话在一个 profile 中共存，并保留不可变 Driver 绑定。外部包必须跟踪确切 Codex schema 与稳定 API；其他 Codex 版本保持不可用，直到该包被有意更新，或用户重建到新的原生 Thread。

受信任域模型有意保持粗粒度。凭据改善归属、取消、记账和审计，但不会创建客户端隔离。官方守护进程与 SSH 工作流不依赖插件重载，而 DSH 保留模型路由和可重建请求的权威。

原生活动为 Web 提供更丰富的时间线，而不会把提供方操作转换为 DSH 工具，也不会把中间过程叙述注入可移植对话历史。Objective、Checklist 和 Proposed Plan 保持为由原生执行拥有的读取投影；原生协作模式 UI 仍不存在。

## 验证

外部包固定 Codex `0.149.1`、相邻的可执行 code-mode host、确切生成 schema 哈希、仅稳定初始化、Unix-socket 传输、方法允许列表、同版本创建／恢复、未知转换重建、经过认证的 Bridge 访问、`ctx.llm` 路由、Codex 重试次数为零、DSH 重试回放、取消、交互、活动、原生 Objective／Checklist／Proposed Plan 投影和 Web 注册。包测试覆盖兼容性准入、JSON-RPC peer、真实常驻守护进程、Bridge 协议与 HTTP 行为、Driver 生命周期、投影映射、交互处理和活动展示。
