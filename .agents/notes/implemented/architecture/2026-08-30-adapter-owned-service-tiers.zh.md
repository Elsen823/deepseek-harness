# Agent Note: 适配器自有的请求服务层

Status: implemented

[English](2026-08-30-adapter-owned-service-tiers.md) | 中文

## Problem

提供方可能提供具有不同延迟、配额与成本行为的请求调度类别。所选类别会影响确切提供方请求，必须可以重建，但其标识符与协议支持归所选适配器所有。产品级 Fast Mode 属于部署选择：把其开关事件与服务层名称放入核心，会让每个组合都携带一个产品的策略。

仓库外请求产生方也需要应用捕获的服务层，而无需 fork agent loop（智能体循环）或把它隐藏在无类型原生载荷中。不支持的路由必须在提供方 I/O 前失败；静默丢弃付费调度选择，会记录并展示提供方并未收到的行为。

## Decision

`ServiceTierId` 是适配器自有的不透明品牌类型，由 `GenerateOptions.serviceTier` 与 `LlmCallConfig.serviceTier` 携带。核心比较并冻结该值，把它纳入 `request/header`，再传给所选适配器；核心不定义服务层名称、默认值或全局选择事件。请求类型由 [LLM 子系统参考](../../../../docs/subsystems/llm-streaming.zh.md) 规定。

适配器在其最终请求边界校验支持情况。`dsh-llm-pi-ai` 仅为 `openai-responses` 与 `openai-codex-responses` 把 `priority` 映射到 OpenAI 兼容的 `service_tier` 字段。其他 pi-ai 协议与 DeepSeek chat-completions 直连适配器会在网络 I/O 前以 `UNSUPPORTED_OPTION` 拒绝显式服务层。

部署插件把 Fast Mode 意图作为必需的外部会话事件持有，在活动期间注册其事件类型，折叠当前选择，并通过请求产生方的 waterfall（瀑布式事件）贡献有效服务层。Codex 集成使用 `fast-mode/selected: { enabled: boolean }` 与 `codex/request-options`；显式 Standard 会删除继承的服务层。其命令只存在于携带 `codex/binding` 的 Agent scope，因此普通会话不会获得其请求路径无法兑现的控件。该事件是必需事件而不是可忽略事件，因为省略它可能重建出不同的提供方请求。

## Alternatives considered

**在核心定义 `llm/service-tier` 与 Fast/Standard 值。** 这会让一个事件名称广泛可见，但会把部署 UI 策略变成提供方无关会话词汇的一部分，并迫使没有该产品功能的读取方理解它。

**只把服务层保存在原生 Driver 载荷中。** 这避免增加核心字段，但使 `request/header` 相等性与重建无法表示有效提供方请求，也没有为非 Driver 适配器提供类型化输入。

**使用通用提供方选项字典。** 这可以在不更改核心的情况下接受未来字段，但会移除编译期所有权，让拼写错误跨越包边界，并且无法声明哪些值影响请求头相等性。

**忽略不支持的服务层。** 这可以让更多路由继续运行，但会虚假报告所选调度行为，并可能在不失败的情况下改变配额或成本预期。

## Verification

LLM 调用配置测试固定服务层的相等性、冻结与已准备调用传播。Session seed 测试拒绝格式错误的持久服务层值，loop 重建测试则从 `request/header` 恢复已分发的服务层。pi-ai 协议测试在真实 Responses 载荷上观察 `service_tier: "priority"`；pi-ai 值、其他协议与 DeepSeek 直连测试则证明不支持的服务层会在网络 I/O 前失败。外部 Fast Mode 生命周期测试固定事件注册、作用域命令所有权、显式 Standard 清除、投影回放，以及 `codex/request-options` 向已记录 Codex 模型请求的传播。

## Consequences

提供方无关请求状态增加一个不透明字段，各适配器仍保有对可接受值与协议映射的权威。持久化 Fast Mode 的部署必须加载其插件才能读取相应会话，从而防止策略拥有方缺失时静默改变未来请求。插件作者需要自行承担事件、projection、命令与迁移，但可以添加调度选择，而无需修改 loop 或用产品专属持久性扩展核心。
