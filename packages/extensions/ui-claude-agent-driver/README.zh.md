# @deepseek-ai/dsh-client-ui-claude-agent-driver

[English](README.md) | 中文

Claude Code Agent Driver 的浏览器端。它通过共享的 `settings.section` slot 提供一个 Web 设置分区，并读取 Host 的通用 `session.drivers` catalog；client runtime 与 core 中都不会加入 Claude 专属 service 或分支。

该分区报告 `claude` Driver 是否可用于新建 Session，并说明原生所有权规则：Claude Code 保留自己的 instructions、skills、tools、hooks、approvals 与执行循环。provider、model 与 effort 不兼容时，宿主适配器会在 turn 开始前拒绝。保留的 Grok id 会显示为空白适配器，而不会被呈现为可执行提供方。

本包不会修改 Claude 设置或凭据。Claude 账户状态、CLI 认证、原生权限与原生 activity 仍由 Host 负责。浏览器插件 fiber 释放时，该入口也会移除；它只提供只读的管理元数据。

同一个可选包还通过 agent-neutral 的 `conversationEvents`、`conversationViews` 与 `conversation.view` 注册提供 `Driver Activity` conversation 标签页。它将有界的 `agent-driver/activity` 事实折叠为只读列表，展示 DSH Session、Driver、原生 conversation、runtime 状态与原生 activity；Chat 仍是唯一的输入 surface。

## 可选 Web 组合

通过专用 Profile 或测试／示例 overlay 加载浏览器行，并同时加载 Host provider 行。不要将其加入 `packages/bundle/web-app/cordis.patch.yml`，以便随包交付的 Web 默认值不加载可选 Claude 包。

```yaml
- insert:
    - id: ui-claude-agent-driver
      name: '@deepseek-ai/dsh-client-ui-claude-agent-driver'
```

## 模型体验

### 只读 Activity 投影

#### 模型看到什么

本包不会添加 prompt、tool schema 或模型可见指令。它把记录的 `agent-driver/activity` 事实、Driver identity、native conversation identity 与 runtime attention 状态呈现给人类操作员。

#### Token 影响

浏览器投影不会发送新的模型请求，也不会消耗模型 token；其 `conversation.view` 输出是持久 Session 事件的 UI read model。

#### KV Cache 影响

加载、刷新或切换标签页不会改变原生 conversation 或其缓存；只有 Host 侧 Chat 输入可以推进原生 turn。

## 已知限制与暂缓事项

- **仅有 Host catalog** —— 浏览器看到活动 Driver 名称，但看不到 provider 凭据或原生设置文件。
- **只读管理与 Activity** —— Claude permission、模型别名、hooks 与账户状态仍需在原生 Claude 配置中修改；Activity 标签页只展示有界的持久摘要，不提供原生协议载荷或控制。
- **真实 attention 呈现仍是人工浏览器门槛** —— 普通离线覆盖使用 `permissionMode: dontAsk`，不提供原生交互回调，因此 provider 测试覆盖 attention 计数，干净的真实模型运行仍需在 UI 中展示待处理的原生交互。
