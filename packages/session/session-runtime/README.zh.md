# @deepseek-ai/dsh-session-runtime

[English](README.md) | 中文

`ctx.sessionRuntimes` 报告持久会话在当前进程中的执行状态，同时保持 `AgentStatus` 的二值完成约定。会话可以处于冷态、激活中、可用或不可用；实时 agent 提供 `idle`／`running` 活动状态，effect 作用域的所有者提供激活阶段，以及彼此独立的批准或用户输入注意状态。

## 所有权

- `observe(header)` 建立冷态基线，并拒绝不可变 Driver 绑定冲突。
- `begin(header, spec)` 创建一项排他的 effect 作用域 Driver 激活贡献。只有返回的 capability（能力凭据）可以改变阶段、操作、Driver 明细或不可用诊断。
- `attend(header, kind)` 提供一项可独立释放的批准或用户输入计数。
- `agent/created`、`agent/status` 与 `agent/disposed` 自动提供实时可用性和活动状态。实时 agent 会覆盖激活失败状态，直至该确切 agent 被释放。
- `setUnavailable()` 在激活贡献退场后保留失败诊断；`setCold()` 在显式重试或管理重置时清除该诊断。
- `session-runtime/status` 发布带有进程内单调修订号的不可变完整值。普通观察者失败会被隔离；不变量失败会在所有观察者收到通知后重新抛出。

运行时状态不是会话日志投影。重启后回放连接中、等待中或进程可用性，会报告已经不存在的资源。持久 Driver 激活、模型请求、活动、Objective、计划与检查点事实使用静态已知的 `agent-driver/*` 会话事件。

## 模型体验

无，因为本注册表只投影进程本地可用性和关注请求，不注册 prompt section、工具 schema、模型消息、流中间件或工具结果。

#### KV Cache 影响

无；本注册表不会组装或发送模型请求。

## 已知限制与后续工作

- 注册表仅在进程内有效，不表示跨 Host 租约或授权。
- 只有 Host 消费方把持久会话 header 传给 `observe()` 后，该会话才会出现；持久化列表仍是持久目录。
- Host 或所选 Driver 诊断缺失的 Driver 注册和版本不兼容，再通过 `setUnavailable()` 记录；本服务不会根据插件是否存在自行推断。
