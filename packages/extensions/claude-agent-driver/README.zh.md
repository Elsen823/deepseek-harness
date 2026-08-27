# @deepseek-ai/dsh-claude-agent-driver

[English](README.md) | 中文

本包为一个持久化的 DeepSeek Harness Session 提供 Claude Code Agent Driver。它是可选的宿主提供方：加载后会注册 `claude` Driver 以及不透明的 `claude-code-settings` contribution，但在绑定该 Driver 的 Session 收到直接 Chat 输入前不会启动原生进程。

## 原生所有权

适配器使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，携带 Session 工作区以及选定的原生模型和 effort。Claude Code 继续负责 instructions、skills、tools、hooks、approvals、权限和执行；适配器不会前置 DSH prompt 文本、把 DSH 工具翻译成 Claude 工具或替换原生策略回调。因此 `inject()` 不产生模型可见上下文，而 `followup()` 与 `steer()` 只接受包含文本块的直接用户消息。

由于此适配器以文本 prompt 模式打开 Claude Query 并让一次原生 turn 完整运行，`steer()` 不能使用 SDK 的 `streamInput()` 边界。它会明确地把直接 steering message 排入下一个 DSH/native turn，因此不会中断活动中的原生 query，并且 steering message 会在下一轮准确投递一次。

原生 query 会收到配置的 `permissionMode` 与可选的可执行文件路径。设置、账户状态、CLI 认证、原生工具执行和 hook 行为仍由 Claude 负责。可选的 SDK approval、elicitation 与 user-dialog callback 只被包装来贡献进程内 runtime attention 计数；它们的返回值仍是原生决定。query 结果成为 DSH assistant message；原生工具和 reasoning 观察成为通用的 `agent-driver/activity` 事实，而不会把原生协议载荷复制进 DSH prompt。

## 模型选择

`ClaudeModelRouteMapper` 在每个 turn 之前验证 DSH provider、model 与 reasoning effort。provider 必须匹配 `provider`；Claude 模型别名通过 `modelAliases` 解析，可选的 `supportedModels` 列表会限制 DSH id 与原生 id。无法表示的 provider、model 或 effort 会抛出 `ClaudeModelSelectionError`，其中保留被拒绝的选择及明确的不兼容原因。可表示的选择除声明的别名转换外原样传给 Claude。

## Session 生命周期与观察

每次 activation 都记录 generic activation、request、attempt、activity、checkpoint、turn 与 assistant-message 事件，从而能够重建 DSH 可见 request 时间线。model-request 事件在调用 `query()` 之前包含准确的直接 prompt 与可序列化原生选项。Claude 的 `system/init` session id 会保留为带品牌的原生 conversation identity；下一次 activation 会使用 SDK 的 `resume` 携带该 identity。client runtime 读取 activation 与 checkpoint provenance 中的通用 `nativeConversationId`，因此首轮 checkpoint 首次记录该值时即可显示原生 identity，无需在 Driver payload 中增加 Claude 专属的 conversation 字段。`observeClaudeSession(session)` 是只读操作：它仅从持久化事件派生 identity、activity 数量和 cold/active 状态，不激活 Claude 也不发 query。取消会中止并关闭原生 query，`whenIdle()` 会等待替代工作汇合后再完成。

Driver 通过 `AgentRegistry.registerDriverContribution()` 提供自己的设置与管理元数据。Core 只不透明地保存该值，并在 Driver generation 卸载时移除它，因此设置消费者拥有自己的词汇，core 不需要 Claude 分支。保留的 Grok id 仍是空白适配器；DSH 专属的 permission、plan、goal 与 tool 消费者继续决定是否支持其他 Driver。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `anthropic` | Claude Code 所表示的 DSH provider id。 |
| `model` | `claude-sonnet-4-6` | 空白 Session 使用的默认原生 Claude 模型。 |
| `modelAliases` | `{}` | 映射到原生 Claude id 的 DSH 模型 id。 |
| `supportedModels` | `[]` | 可选的精确模型白名单；为空时使用 Claude id 与别名识别。 |
| `supportedEfforts` | `low, medium, high, xhigh, max` | 此部署接受的原生 effort 值。 |
| `permissionMode` | `dontAsk` | 每次 query 使用的原生 Claude 权限模式。 |
| `cliPath` | 未设置 | 可选的 Claude Code 可执行文件路径。 |

## 可选 Profile 组合

将 provider 行加入明确安装 Claude Code 的 Profile patch。不要将此行加入随包交付的 Web bundle，以便默认 Web 组合保持无密钥且与具体提供方无关。

```yaml
- insert:
    - id: claude-agent-driver
      name: '@deepseek-ai/dsh-claude-agent-driver'
```

## 模型体验

### Chat 输入与输出

#### 模型看到什么

原生 Claude Code 进程看到传给 `query()` 的直接用户文本以及它自己配置的 instructions、skills、tools、hooks、approvals 与执行策略。DSH 不会再添加一份 system prompt，也不会把 DSH tool schema 注入原生请求。DSH transcript 接收原生最终答案和用于观察的通用 activity 行。

#### Token 影响

原生进程负责自己的上下文与 token 统计。当 Claude 同时提供两个数值时，DSH 会在 model-attempt 与 assistant-message 事件上记录 input 与 output usage；它不会重新计算原生 instructions、skills、tools 或 hook 载荷的 token。

#### KV Cache 影响

原生 continuation 使用 Claude 的 conversation identity 与原生持久化。DSH 模型选择会在下一个请求前记录，因此 provider、model 或 effort 改变会开始新的 effective route，而已经记录的消息保持不可变。

## 已知限制与暂缓事项

- **仅支持直接文本** —— image、tool-result 与其他非文本 Chat block 会以明确的输入错误被拒绝。
- **原生 prompt 内部保持不透明** —— Claude SDK 不暴露最终的 instructions、skills、tools 或 hook 扩展 prompt，因此持久 request 记录准确的直接 prompt 和生效的 adapter 选项，并列出这些未暴露的原生输入，不声称能够完整重建原生请求。DSH 不合成 approval 或 user-input 决定；Host 提供 SDK callback 时，runtime attention 计数覆盖其等待区间，而决定权仍属于 Claude。
- **原生 activity 会被摘要** —— 持久化时间线记录不含身份信息的 activity 标题与有界数据，而不是原始 Claude 协议消息、凭据、stderr 或完整工具参数。
- **Resume 需要原生 conversation** —— 原生 identity 不可用时，Session 会被观察为 cold，直到新的 query 建立 identity。
