# Agent Note: 可记录的请求服务层

Status: implemented

[English](2026-08-23-logged-request-service-tiers.md) | 中文

## Problem

Codex Fast mode 不是模型切换，也不是推理强度捷径。它选择提供方请求服务层 `priority`，而标准选择会移除该覆盖。Harness 没有承载这项决定的调用配置字段，因此已安装的 `/fast` 插件既无法通过 `agent/request` 传递 service tier，也无法让实际协议请求从 `request/header` 重建。在 `llm/stream` 中改写已经冻结的请求，会让提供方请求与持久 header 不一致。

pi-ai 依赖的 OpenAI Responses 实现已经接受 service tier，但它的协议无关 `streamSimple()` 选项没有该字段。直接 DeepSeek chat-completions 适配器则完全没有 service-tier 协议字段。因此，共享请求值还必须由适配器显式映射或拒绝，不能静默省略。

## Decision

`dsh-llm` 拥有不透明品牌类型 `ServiceTierId`。`LlmCallConfig.serviceTier` 与 `GenerateOptions.serviceTier` 承载所选的适配器自有 id，`callConfigEquals()` 会比较它。Agent request waterfall 可以返回带 tier 的替换配置；Agent Loop 随后准备精确适配器调用，把 tier 写入完整 `request/header`，并在现有[请求可重建规则](../../implemented/architecture/2026-07-05-reconstructable-requests.zh.md)下从该 header 构造冻结请求。

`@deepseek-ai/dsh-llm-pi-ai` 仅在 `openai-responses` 与 `openai-codex-responses` 上接受显式 tier。其通用流路径通过 pi-ai 的 `onPayload` hook，在 pi-ai 构造完有类型的请求 body 后加入提供方字段 `service_tier`。其他 pi-ai 协议会在解析凭据或进行提供方 I/O 前以 `UNSUPPORTED_OPTION` 拒绝该选项。`@deepseek-ai/dsh-llm-deepseek` 同样会在提供方 I/O 前拒绝，因为 DeepSeek chat completions 没有定义该字段。

已安装的 `@dsh-external/dsh-fast-mode` 是首个产生方。核心会话词汇包含全值 `llm/service-tier` 事件，使持久化读取器能够识别已安装插件的持久选择：`ServiceTierId('priority')` 表示 Fast，`null` 表示提供方标准服务层。插件会在下游 `agent/request` 路由完成后应用该选择。浏览器 decoration 展示“快速”和“标准”选择，但最终仍通过 Host 命令提交 `/fast on` 或 `/fast off`，因此持久事件是唯一状态写入路径。

## Alternatives considered

- **把 Fast mode 映射为推理强度 `off`。**拒绝，因为 Codex Fast mode 通过 `service_tier: "priority"` 改变请求调度；它不会关闭推理、选择另一个模型或改变提供方路由。
- **在 `llm/stream` 中改写请求。**拒绝，因为 loop 构造的 `GenerateOptions` 到达那里时已经写入日志并冻结。晚期改写会破坏请求重建与 prepared-call equality。
- **增加通用无类型 provider-options bag。**本产生方不采用，因为 loop 无法在没有定义持久 equality 语义的情况下比较或记录相关字段。聚焦的不透明 id 保持了较小接口，并让每个适配器显式映射或拒绝。
- **发送自定义 HTTP header。**拒绝，因为 OpenAI Responses 定义的是 JSON body 字段，网关也通过该字段执行 service-tier 计费与路由。

## Consequences

按会话的 Fast mode 变更是持久事实，可在 resume 与 fork 后保留，并会在实际 tier 变化时产生新的 `request/header`。提供方适配器不能静默忽略该字段：受支持的 Responses 协议会发送它，不受支持的协议会在网络 I/O 前失败。核心词汇刻意不公布模型支持哪些 tier；当前产生方选择已有证据的 `priority` id，等第二个消费方需要可选择的 tier catalog 时，再引入提供方能力发现。
