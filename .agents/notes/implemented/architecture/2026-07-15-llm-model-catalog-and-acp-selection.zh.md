# Agent Note: 建议性 LLM 目录与 ACP 会话级模型选择

Status: implemented

[English](2026-07-15-llm-model-catalog-and-acp-selection.md) | 中文

> 目录决策仍然有效。ACP（Agent Client Protocol）会话级模型选择已由 [ACP 作为仅面向自动化的协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)取代。

## 问题

基于提供方路由的适配器允许每次请求选择 `provider + model`，但 `LlmRuntime` 只暴露路由和流式调用。UI 无法发现已注册的提供方，也无法知道适配器愿意推荐哪些模型。因此，ACP 客户端收不到 `model` 会话配置项；即使 LLM（大语言模型）服务已经支持运行时切换，Zed、JetBrains 和 VS Code 集成仍没有模型列表。

模型发现不能变成请求校验。手写 DeepSeek 适配器会把任意模型 ID 原样转发给公开或私有端点，而 pi-ai 的有限安装目录则是其自身请求解析的权威依据。将共享目录视为白名单，会破坏提供方路由需要保留的私有端点能力。

ACP 选择还必须保留提供方维度。同一个模型 ID 可能存在于多个路由下；切换全局适配器或 agent（智能体）模板会让一个编辑器会话的选择泄漏到其他会话。提示词变量与请求路由必须同时变化；如果选择发生在异步提示词组装期间，不能让 `{{model}}` 表示一个模型、实际请求却到达另一个模型。

## 决策

### 提供方无关的建议性发现

`LlmAdapter` 增加 `providerInfo(provider)` 与异步 `listModels(provider)` 方法。其提供方无关结果分别为 `LlmProviderInfo { id, name }` 和 `LlmModelInfo { provider, id, name, description? }`。默认实现以路由名称作为提供方名称，并且不展示模型，从而保持现有适配器行为。

`LlmRuntime.listProviders()` 按注册顺序返回元数据副本。`LlmRuntime.listModels(provider)` 委托给路由所有者，校验非空 ID 和名称，并在提供方不匹配或模型 ID 重复时以 `INVALID_CATALOG` 失败，最后返回值的副本。未知提供方仍以 `NO_ADAPTER` 失败。提供方元数据在 `registerAdapter()` 期间进行原子校验，错误展示记录不会留下部分注册。

目录成员关系仅提供建议。它驱动选择器与诊断，但不会改变 `stream()` 路由，也不会拒绝原本有效的请求。提供方所有权仍然具有排他性并绑定生命周期；模型 ID 仍是请求时传给适配器的输入。

`dsh-llm-pi-ai` 将已配置提供方的 `getModels(provider)` 返回的已安装条目映射为提供方无关的目录。其现有请求时目录查询仍是权威依据，未知模型仍以 `UNKNOWN_MODEL` 失败。`dsh-llm-deepseek` 接受包含展示条目的可选 `models` 配置，默认包含名为 `DeepSeek-V4-Flash` 的 `deepseek-v4-flash`、名为 `DeepSeek-V4-Pro` 的 `deepseek-v4-pro`，以及名为 `DeepSeek-V4-Flash-Vision-Exp`、支持图片输入的 `deepseek-v4-flash-vision-exp`。显式列表会替换这些默认值，空列表则关闭发现。这些条目改善已知公开或私有模型的选择体验，而所有未列出的模型 ID 仍会原样透传。

### 前端内的会话级选择

已接受的选择由 Agent 所有的 Session Model Selection 生命周期持有；TUI 和 Web 等前端只负责呈现并提交它。`LlmRuntime` 和 `AgentOptions` 是部署级或创建级对象，改动它们会把并发 Session 耦合在一起。每个不透明选项都携带完整的提供方／模型对，因为同一模型 ID 可能出现在多个路由下。

ACP 自动化传输层不是目录消费方。它通过部署配置为新创建的 agent 提供一个可选的提供方／模型目标，不展示模型选择器或配置选项接口。

### 提示词／请求一致性与持久化

每个 live Agent 都携带一个 Session 局部的 Model Selection 所有者。Driver 在提示词组装或模型 I/O 前的 Turn 开始时捕获并解析一个不可变选择，该 Turn 的每个请求都使用捕获值。Model Selection 不由 prompt assembly 或 request middleware 持有或路由。

`model/selected` Session 事件记录已接受的 intent，即使请求尚未消费它。`request/header` 与 Driver 的 model-request 事件仍是生效请求证据；它们独立折叠，不会替代 selected intent。Session 选择不会改变未来 Session 使用的部署默认值。

## 考虑过的替代方案

**只返回模型字符串。** 只有模型的值会丢失提供方路由，一旦两个提供方暴露相同 ID 就会产生歧义。

**将目录设为强制白名单。** 这与手写适配器的任意模型透传和私有部署冲突。请求的权威校验本就属于被选中的适配器。

**把选择存进 `AgentOptions` 或 `LlmRuntime`。** 它们是创建级或部署级对象。改动它们会把并发 Session 耦合在一起，并绕过 Agent 所有的 Session 生命周期。

**只把首个请求作为持久化选择。** 已接受的选择必须在首次请求前重启后保留，并且必须与生效请求证据区分。`model/selected` 记录 intent，`request/header` 记录消费。

## 结果

- 任意适配器都能暴露动态模型列表，无需把提供方库类型泄漏到 LLM Service Definition。
- 目录消费方必须把缺失理解为「未展示」，而不是「请求无效」。
- pi-ai 适配器会暴露其已安装的提供方目录；手写 DeepSeek 部署显式列出已知选项，同时保留对任意模型的支持。
- 面向人类的目录消费方拥有各自的选择交互。ACP 使用固定部署目标，不会为模型发现扩大协议范围。
- `model/selected` 事件记录已接受的 intent，且不改变 Session 格式版本；请求头仍是生效的提供方路由证据。
- 目录读取可以是异步的，且每个调用方都会收到值的独立副本。

## 测试

单元测试覆盖目录值副本与格式错误的元数据、pi-ai 和 DeepSeek 目录投影、提供方／模型请求路由，以及提示词变量对齐；监听器安装在 agent 作用域的上下文中，因此能够实现 agent 间隔离。ACP 传输测试独立验证固定提供方／模型的转发行为；TUI 套件覆盖选择器交互与基于请求头的恢复。
