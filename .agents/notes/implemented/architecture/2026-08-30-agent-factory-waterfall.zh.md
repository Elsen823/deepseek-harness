# Agent Note: 全局 agent 工厂 waterfall

Status: implemented

[English](2026-08-30-agent-factory-waterfall.md) | 中文

## Problem

`AgentRegistry` 公开一个由 `dsh-agent-loop` 实现的工厂槽位。该 seam 让消费方不依赖 loop 包，但外部主 agent 驱动器只能替换整个进程的默认工厂，或在 loop 内部维护 fork，才能参与构造。若通过每个 Session header 中的新 `driverId` 选择替代实现，就会把 provider 策略扩散到 Session 创建、持久化、SDK、UI、示例与迁移中，尽管大多数部署仍然只需要一个默认 loop。

部署需要拦截所选 create 与 resume 操作，保留原始调用方所有的 Cordis 上下文，并返回相同的生命周期所有 `AgentHandle` 抽象，同时不改变现有调用方。

## Decision

`AgentRegistry.create()` 与 `resume()` 把带判别字段的 `AgentFactoryRequest` 路由进全局异步 `agent/factory` waterfall。请求保留操作种类、原始选项对象与带调用方追踪的 `ownerCtx`。监听器可以返回替代 `AgentHandle`，从而拥有完整生命周期，也可以调用 `next()` 与后续监听器组合。终端 continuation 使用同一个所有者上下文和可追踪 receiver 调用现有唯一注册的 `AgentFactory`。

默认工厂仍然是单一槽位。被拦截器处理的请求不要求该槽位存在；没有已注册工厂的请求若抵达终端 continuation，则使用现有的“加载 agent-loop”诊断失败。工厂提供方与替代监听器都返回公开 handle，因此取消、所有权、teardown 与调用方行为不会增加第二套抽象。

选择策略属于拦截插件。Core 不添加驱动器注册表、必填 Session header 判别字段、按持久字符串回退，也不认识任何外部驱动器。需要持久恢复所有权的驱动器通过插件所有的 Session 事件记录该状态，并独立注册这些事件类型。

## Alternatives considered

**在 `SessionHeader` 中加入 `driverId`，并建立按它索引的注册表。** 未采用，因为这会把一项部署选择变成永久核心持久化与 wire 字段，迫使每条创建路径选择驱动器，并在存在多个第一方驱动器之前就赋予驱动器高于其他构造拦截器的地位。

**让外部插件替换唯一工厂。** 未采用，因为随附 loop 仍然拥有普通 Session，两个提供方无法安全争用同一个槽位或独立卸载。

**在 `dsh-agent-loop` 内部增加扩展钩子。** 未采用，因为替代构造仍会耦合到具体驱动器包，并违反新行为应使用公开扩展点而不是修改 loop 的规则。

**以优先级注册多个工厂。** 未采用，因为这会在 core 中混合选择策略、提供方身份与回退顺序。Cordis waterfall 顺序已经提供显式组合，每个监听器都能决定是否继续委托。

## Consequences

外部主驱动器可以只处理自己拥有的 Session，而普通 loop 继续作为其他请求的默认实现。现有调用方、handle 与 Session header 均不改变。拦截器获得的是强生命周期 seam：一旦短路，它就必须复现 `AgentHandle` 消费方依赖的创建/恢复校验、发布、回滚、发起方归因与 teardown 保证。

注册表测试固定 create 与 resume 使用原始选项和调用方 fiber 委托、无默认工厂时短路、下游回退，以及不变的单工厂生命周期。生成的 Cordis 目录公开请求签名与 waterfall mode。
