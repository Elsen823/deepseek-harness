# Agent Note: 常驻 Codex 支持的会话

Status: implemented

[English](2026-08-23-resident-codex-backed-sessions.md) | 中文

## 问题

现有 Codex subagent 集成有意为一个委派任务启动一个全新产品进程、返回最终结果并终止该进程。此行为继续适合 [Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)，但无法让 Codex 成为持久 DSH 会话的执行实现，也无法提供恢复、流式活动、交互、取消和原生工作状态。

常驻集成还必须在 Codex 运行于 Host 时，让 DSH 中配置的模型 route 与凭据保留在 DSH。Codex app-server schema 和原生持久化可能随已安装运行时变化，因此激活过程必须证明所需行为与原生状态所有权，而不能把成功的 `thread/resume` 当作宽泛兼容性承诺。

主要来源约束和相邻版本证据仍记录在 [跨版本恢复报告](../../../research/codex-cross-version-resume.md)、[共享常驻服务报告](../../../research/codex-shared-app-server-remote-clients.md)和[原生 Goal 与 Plan 报告](../../../research/codex-goals-plans-dsh-integration.md)中。通用生命周期由 [会话绑定的 Agent Driver（智能体驱动器）](../architecture/2026-08-23-session-bound-agent-driver-registry.zh.md)负责，通用运行时与工作状态由 [Driver 无关的会话运行时与工作状态投影](../architecture/2026-08-23-driver-neutral-session-runtime-and-work-state.zh.md)负责。

## 决策

### 外部混合包与常驻守护进程

实现位于外部混合包 `@dsh-external/dsh-codex-agent-driver`，路径为 `/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver`，并包含 Host 与 Web 入口。它注册 `codex` Agent Driver、经过认证的 Responses Bridge、交互处理器、Driver 活动展示、Driver 选择、运行时与身份展示、原生工作状态展示、只读 TUI 观察器和“其他 CLI”Host 管理设置，而不会在内置 DSH 循环中增加 Codex 专属分支。

官方 Codex 常驻管理器拥有守护进程。配置的 CLI、code-mode sidecar、daemon 描述、schema 与行为探针通过准入后，`start-if-absent` 可以调用管理器的幂等 `daemon start`；`require-running` 则由操作员负责启动。仅限 loopback、需要确认的设置操作可以在当前代际身份预检、零 live Agent 与零 attention 检查以及明确候选准入后调用 `daemon restart`，随后通过新的 initialize／initialized 握手与行为探针重新核验恢复后的 daemon。插件重载、Driver dispose（资源释放）、浏览器断开连接和 DSH 关闭会释放 DSH 连接与激活，但不会停止共享 daemon，也不会把它视为 Cordis 子进程。插件绝不执行 daemon bootstrap 或启用远程控制。运维设置、外部版本转换、回滚和 SSH 配置使用官方守护进程向导，而不是自定义 systemd 或 launchd 单元。

### 单一受信任 OS 与 `CODEX_HOME` 域

一个操作系统身份和一个 `CODEX_HOME` 构成一个完全受信任域。域内客户端共享文件系统权限、Codex 配置、原生 Thread 目录、提供方路由可达性和模型支出后果。激活凭据标识具有归属的 DSH 生命周期，并支持关联、记账、取消和撤销；它们不能让互相信任的客户端彼此隔离。更窄的信任需求使用独立操作系统身份和 `CODEX_HOME`。

远程人工使用原生 Codex TUI 时通过 SSH 运行，且不得作为第二个写入方连接到 DSH 正在持有的 Thread。Orca 使用其远程终端与 SSH 工作流，而不充当 app-server 协议客户端。浏览器 TUI 读取持久 DSH conversation 与 Driver Activity 投影；它既不是原生 Codex TUI，也不是另一个 app-server 客户端。该集成不会把常驻守护进程公开为通用网络 WebSocket 服务。

Host 目录包含当前 DSH 候选项以及显式配置的额外 `CODEX_HOME`、CLI 与套接字候选项。它不会扫描进程，也不会从环境中的套接字推断彼此独立的 daemon home。额外候选项只会被观察，不会自动启动。Web 为主条目标记“（当前 DSH）”，并报告运行中、不可用或不兼容状态。对于每个运行中的 Host，它会列出当前进程的 live Codex Agent，包括 DSH Session、原生 Thread、DSH 模型 route、活动与注意力身份。只有当前 ApiProxy 保留确切 handle 的空闲 Agent 才能被释放；释放会保留持久 Session。重启会阻止新的当前 Host preparation，等待已经进入的 preparation 完成发布或回滚；随后若当前 DSH 进程仍有活跃 Codex Agent 或 pending attention，该条目的重启会被拒绝。显式确认也会告知用户，进程外客户端无法完整枚举且都会断开连接。

显式选择为常驻的 Codex Session 还参与通用的[进程代际重启交接](../architecture/2026-08-26-process-generation-restart-handoff.zh.md)。交接 sidecar 会绑定 Session checkpoint、Driver、模型选择和原生 Thread 状态；兼容的新代际通过不订阅的 read/resume 恢复，不调用 `dispose()`、不发出释放事件，也不发送 `thread/unsubscribe`，而有界交接失败会让旧代际继续提供服务。

### 经能力证明的稳定 Codex 协议

该包携带生成的协议 schema 与观测版本基线作为构建来源信息，而不是固定的运行时版本要求。加载期准入会哈希配置的 CLI 与相邻可执行 `codex-code-mode-host`，并在 sidecar 帮助、CLI 版本和 schema 检查期间证明两者身份保持稳定；只有随后启动策略才能处理不可用的 daemon。准入读取运行中的 daemon 描述，要求 CLI／daemon 描述动态一致、套接字匹配、托管 CLI 与 sidecar 字节一致并保持身份稳定。每个 Session 激活都会在连接前重新核验当前代际。受控重启会有意重新解析配置路径上由操作员外部安装的可执行文件，再通过新的传输与行为探针准入新代际；不兼容或行为不完整的运行时会 fail closed，同时保留 DSH 与原生持久状态。它只使用稳定 API（`experimentalApi: false`），并通过仅所有者控制的 Unix socket 上的 WebSocket 通信。客户端方法和一等通知投影采用精确允许列表；未知服务器请求和未知模型可见项目会以安全方式失败，而有界的未知信息性通知保留为后备活动。

新 DSH 会话启动一个持久 Codex Thread。恢复使用 Agent Driver 激活与检查点事件中记录的原生 Thread id，并且只在运行时能力证明和不订阅的 `thread/read` 身份检查后接受状态。行为缺失或不兼容、Thread 缺失、身份不符，或 read／resume 被拒绝时，都会记录显式重建，并仅根据可移植 DSH 历史中的直接用户消息、可见 assistant 文本和用户图片建立新 Thread。插件生成的 context、推理、旧命令、批准、原生工具、工具结果和副作用不会回放。

官方守护进程向导负责设置、版本更新、回滚和 SSH 指引。插件绝不执行隐式原生状态迁移，也不安装自己的服务管理器。

原生 conversation 不可用时，系统不会透明启动交互式 `codex resume`。交互式 CLI 活动会成为 DSH Session 日志之外的第二个 Thread 写入方。恢复只通过 Driver 的精确续接与显式重建行为完成。

打开浏览器 TUI 不会激活 Agent 或启动模型 Turn。它把持久用户与 assistant conversation node、当前流式 assistant 投影和经过净化的 Driver Activity 合并为一条终端风格时间线。它没有 shell、PTY、可写 RPC 或进程控件。选择 TUI 时不会显示常驻 composer，切回 Chat 后恢复；Chat 是唯一 Web 输入路径，Driver 仍是 Codex Thread 的唯一写入方。

### 经过认证的 DSH Responses Bridge

Codex 获得一个逐激活 Responses 提供方，其经过认证的回环端点由插件 Host 托管。Bridge 通过 `ctx.llm` 解析并执行模型调用，因此提供方凭据和 Model Route 所有权保留在 DSH。回环来源不构成授权；每个 Bridge 请求都会检查基于命令的激活凭据，并在释放时移除该凭据。

Driver 只把用户直接编写的 Chat 消息发送给原生 Codex turn 与 steering 方法。它不调用 DSH `agent/pre-step` waterfall，不组装 DSH system prompt，也不向 Codex 传递 memory recall、skill 目录和权限提醒等插件生成的 context。Codex 拥有其原生 instructions、`AGENTS.md`、tools、skills 与执行循环；DSH 拥有模型路由、经过认证的传输、已接受消息的持久化、交互转发与 Chat 投影。

直接 Chat 文本中的显式 `$name` 会按 Session 工作目录通过原生 `skills/list` 解析。Driver 保留完整文本，并且只为已启用的精确匹配追加原生 skill 输入，名称与绝对路径均使用 Codex 返回值。未知和禁用名称仍保持为文本。Skill 发现与指令加载保留在 Codex 内，而不会变成 DSH prompt assembly。

Codex 的 `request_max_retries` 和 `stream_max_retries` 均为 `0`。Bridge 执行 DSH 捕获的重试策略，通过静态 Agent Driver 事件记录确切模型可见请求和每次尝试，流式传输受支持的 Responses 输出、报告用量并传播取消。不受支持的请求内容或 route 能力会在不安全的原生执行开始前失败。

### 会话、交互与工作状态映射

一个原生 Codex 轮次映射为一个 DSH Turn。已接受用户消息与最终 assistant 答案使用核心对话语义；原生命令、文件变更、差异、MCP 调用、推理（reasoning）摘要、状态、部分进度和错误使用 Driver 活动快照。批准与用户问题请求通过 DSH 交互服务路由、贡献彼此独立的运行时注意力计数，并且未知请求方法会以安全方式失败。

Codex 原生 Goal 快照投影为可移植 Objective，而不创建 DSH `goal/change`。稳定原生计划更新投影为可移植 Checklist，而不挂载 `todo_write`；已完成计划文档投影为 Proposed Plan。内置 DSH Goal、Plan Mode 和权限预设只拥有 `dsh` Session；跨 Driver fork 会省略其控制事件，composer 也会对备用 Driver 隐藏这些控件。已交付的 Web 集成提供 Driver 选择器、红／黄／绿侧边栏状态标记、携带 DSH Session、原生 Thread 与 DSH route 身份的运行时徽标、活动视图、Objective dock、通过原生投影提供的 Checklist、Proposed Plan dock、只读 TUI 观察器，以及带 Codex 和预留 Grok 页签的“其他 CLI”设置。它不声称或渲染原生协作模式 UI。

## 考虑过的替代方案

**复用一次性 subagent 提供方。** 其全新进程与最终结果生命周期按设计不拥有持久父会话、交互式时间线或原生恢复。

**每个会话启动一个 app-server。** 这会放弃官方常驻守护进程模型、成倍增加进程与更新状态，并阻止受信任的 Host 侧 TUI 工作流共享同一个原生服务。

**把 daemon 当作 Cordis 拥有的子进程。** Cordis 释放会终止共享服务或留下脱离管理的子进程。插件可以请求有界的官方管理器操作，但绝不拥有 daemon 生命周期，也不会在卸载时停止 daemon。

**发现任意 app-server 进程。** 进程 id 无法认证连接所需的 `CODEX_HOME`、托管二进制、套接字、协议版本或信任域。目录使用显式候选项与官方 daemon 描述。

**降级为交互式 `codex resume`。** 该进程会写入原生 Thread 状态，却不会把模型可见活动投影到 DSH Session 日志，从而产生模糊所有权和不可重建历史。

**在浏览器 TUI 中嵌入可写 Codex CLI 或 DSH shell。** 第二条输入与进程控制路径会把对话权威从 Chat 中拆分出去，并可能产生不属于持久 DSH 投影的活动。TUI 只观察现有投影，不持有执行。

**配置的二进制改变后仍执行重启。** 在替换发行物和状态迁移得到认证前中断兼容的常驻 daemon，可能让全部共享客户端失去可用服务。DSH 会先核验仍运行的旧代际，再有意准入配置路径上由操作员外部安装的候选，并在重启后要求新的传输与行为探针；向导不会绕过 live Agent 或 pending attention 检查。

**安装自定义 systemd 或 launchd 单元。** 这会重复官方守护进程的设置、更新、回滚与 SSH 工作流，并创建第二个生命周期权威。

**声称一个守护进程内存在逐激活隔离。** 激活凭据提供归属与取消，但共享操作系统身份和 `CODEX_HOME` 仍保留共同原生权限。隔离需要不同的受信任域。

**模型调用直接使用 Codex 账户凭据。** 这会绕过 DSH Model Route、适配器、重试策略、用量所有权和凭据策略。Responses Bridge 使这些职责保留在 DSH。

**将成功的 `thread/resume` 视为兼容性证明。** 原生持久化可能被接受，同时记录被跳过或重新解释。能力与行为证明以及显式重建避免作出这种不受支持的承诺，同时不要求版本精确相等。

**因为存在原生计划而公开原生协作模式。** Checklist 进度与已完成 Proposed Plan 已交付，但不存在原生协作模式控制与 Web UI。该集成不会从计划事件推断出此能力。

## 后果

Codex 支持的会话与内置 DSH 会话在一个 profile 中共存，并保留不可变 Driver 绑定。构建生成的 schema 继续作为有用的来源信息；只要所需能力与行为探针通过，运行时准入可以接受新增的 Codex 版本。能力缺失或不兼容会保持不可用，并保留原生／DSH 持久状态，供显式重建到新的 Thread。

受信任域模型有意保持粗粒度。凭据改善归属、取消、记账和审计，但不会创建客户端隔离。官方守护进程与 SSH 工作流不依赖插件重载，而 DSH 保留模型路由和可重建请求的权威。自动启动可以补齐缺失但兼容的主 daemon，且不会让卸载变成破坏性操作。其他 daemon home 需要显式目录条目；当前 DSH Host 仍拥有活跃 Agent 时，重启保持不可用。

原生活动为 Web 提供更丰富的时间线，而不会把提供方操作转换为 DSH 工具，也不会把中间过程叙述注入可移植对话历史。Objective、Checklist、Proposed Plan 和 TUI 保持为由原生执行拥有的读取投影；原生协作模式 UI 仍不存在。

## 验证

外部包证明配置的 CLI、相邻的可执行 code-mode host、CLI／daemon 描述动态一致性、仅稳定初始化、Unix-socket 传输、所需行为探针、方法允许列表、兼容的创建／恢复、未知转换重建、经过认证的 Bridge 访问、`ctx.llm` 路由、Codex 重试次数为零、DSH 重试回放、取消、交互、活动、原生 Objective／Checklist／Proposed Plan 投影和 Web 注册。包测试覆盖自动启动前兼容准入、已运行 daemon 的无操作启动、同路径候选替换、重启切换后的证据失效、重启预检与后检、Host 状态分类、live Agent 与 pending attention 重启拒绝、loopback RPC 请求验证、“其他 CLI”页签与确认、Session 身份与侧边栏状态、不带 DSH pre-step 或插件 context 的直接 Chat 转发、针对起始与 steering 输入的逐工作目录原生 skill 解析、未知与禁用 skill 文本、重建过滤、只读 TUI 排序并省略 DSH context 与可写控件、不存在 terminal RPC 方法、JSON-RPC peer、行为兼容与不兼容的伪 Host 代际、真实常驻守护进程、Bridge 协议与 HTTP 行为、Driver 生命周期、投影映射、交互处理和活动展示。
