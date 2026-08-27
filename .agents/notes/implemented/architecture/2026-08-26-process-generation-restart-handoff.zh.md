# Agent Note: 面向常驻 Agent Session 的进程代际重启交接

Status: implemented

[English](2026-08-26-process-generation-restart-handoff.md) | 中文

## Problem

Agent、它的 Cordis 作用域和原生 Driver 连接都属于一个 DSH 进程，而显式选择常驻的 Session 必须在 Web 进程被替换时保持逻辑 Session 与原生 Thread 的连续性。普通提供方卸载、显式 Release Agent 和进程停止会有意释放这些资源并发出生命周期边，因此把每个停止信号都当作重启要么会拆除常驻工作，要么会让所有权不明确。

## Decision

通用 Agent 注册表除了普通释放之外，还公开一个明确的 `restartHandoff()` 操作。它在 `requested` 阶段将带版本的、仅所有者可读写的 sidecar intent 写入磁盘，在 `committed` 阶段原子发布常驻 Session 记录，并将失败请求标为 `rejected`；重启不会从 `SIGTERM` 推断，只有进入此操作的调用方才能取得交接语义。

### Sidecar 所有权与校验

`RestartHandoffStore` 在模型可见的 Session 日志之外保存代际、租约过期时间、明确的 `resident: true`、Session 和 Driver id、已刷新事件数量与摘要，以及 Driver 所有的无损 JSON 状态。它使用仅所有者目录、排他临时文件、原子替换、带死锁恢复的串行代际锁和 compare-and-replace claim；未过期的代际或 Session claim 会拒绝第二个所有者，而过期 claim 可以在不改变记录身份的情况下恢复。

### 有界停稳发布

`AgentRegistry.restartHandoff()` 会关闭新的生命周期与 API 准入，等待已经准入的操作，等待每个显式选择的 Agent 变为 idle，对其 Session 恰好刷新一次，确认 Session 前缀未改变，然后向通用 Driver handoff hook 请求状态。所有可能失败的 Driver 校验都在发布前完成；记录成组发布后注册表进入 `committed`，隔离每个旧条目，并调用必须是不可失败的进程本地状态翻转的同步 commit。超时、取消、缺少 hook 或前缀变化都会拒绝 intent，并在不调用普通 Agent 或 Driver 释放的情况下让旧代际恢复提供服务；发布后的 commit 若违反要求抛错，注册表仍保持 committed，绝不会重新开放旧代际。

### 重新挂接与请求隔离

下一个组装出的代际只列出已提交的常驻记录，逐条 claim 精确记录，校验 Session id、不可变 Driver id、事件数量、摘要和 Driver 专有状态，然后经过普通的未发布准备事务恢复，将精确的新 handle 转交给 API proxy，再完成 claim。Driver 在兼容性证明通过时可以重新挂接同一个原生 Thread；原生状态缺失或不兼容时则使用既有的明确可移植重建策略。准备或所有权转交失败时 claim 会释放以便重试；如果转交成功后完成发生竞争，替代 Agent 与 claim 会继续保持隔离，不会销毁已由 API 代际持有的 handle。旧 API 代际中跨过交接屏障的请求会收到可重试的代际响应，陈旧 handle 不能释放替代 Agent。

### 不释放不变量

成功交接不会调用 `PreparedAgentDriver.dispose()`，不会发出 `agent/disposed` 或 `session/disposed`，不会追加 Driver 激活 `stopping` 或 `stopped`，也不会发送原生 `thread/unsubscribe`。Codex Driver 的 handoff commit 会在 idle 后隔离其 Agent，并允许进程本地 handle 随旧进程消失；显式 Release Agent、提供方卸载、普通停止和交接拒绝继续使用现有的释放与持久性退休行为。

## Alternatives considered

**从 `SIGTERM` 推断交接。** 拒绝，因为 supervisor 停止和明确重启具有不同的持久性与释放义务；未区分的信号无法证明意图，也无法安全保留常驻所有权。

**对常驻 Agent 跳过 `fiber.dispose()`。** 拒绝，因为旧注册表、持久性 owner、API handle 映射和原生连接仍会与即将退出的进程绑定，没有有界屏障或重复代际保护。

**把常驻信息放入 Session 日志，或从 `driverId` 推断。** 拒绝，因为进程所有权不是模型可见状态，已保存的 Driver 历史也不表示 Session 选择了复活；sidecar 保持 Session 格式不变，并要求明确标记。

**把 Agent 注册表移入常驻 supervisor。** 本基础实现拒绝，因为它是唯一能保留同一个 JavaScript Agent 对象的设计，但会增加经过认证的进程边界、IPC 生命周期、启动顺序和第二套故障恢复协议。如果不间断的进行中执行或对象身份成为需求，它仍是合适的架构。

## Consequences

逻辑连续性被定义为相同的持久 Session id，以及在兼容时相同的原生 Thread id，同时使用新的进程本地 Agent 和 API handle。常驻选择必须在 Session 创建或恢复时明确给出，部署边界在 AgentRegistry 加载时校验，sidecar 代际和租约独立于 `SESSION_FORMAT_VERSION` 进行版本管理。

交接屏障会恰好保留一次已接受的持久写入，拒绝时让旧代际继续服务，但不能跨进程保留进行中的浏览器请求或 JavaScript 对象。客户端按 Session id 重新连接并重试带代际隔离的请求；缺失或不兼容的原生状态仍通过 Driver 的重建状态与策略显式呈现。

## Verification

Core 测试覆盖 sidecar 原子 intent、死锁恢复、租约、精确 claim、有界停稳、恰好一次刷新、普通释放、发布后 commit 失败、完成竞争时的保留、失败采用清理和过期 API 请求。外部 Driver 测试覆盖无 unsubscribe／无 teardown 的交接、同一 Thread 校验、原生重建和普通释放；Loader 测试通过已发布的 `apply` 入口，使用共享临时持久化与伪原生 Host 启动两个真实组合，并在第二代际采用精确的常驻 Session，验证新 Agent handle 且没有重复或 teardown 事件。无密钥 assembled Web snapshot 固定 Session／原生 reconnect 身份；真实 Web／Host 重启、浏览器、模型、Agent 释放、回滚与持久日志校验仍依据[测试策略](../../../../docs/testing.zh.md)作为需要单独授权的操作。
