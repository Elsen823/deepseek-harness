# @deepseek-ai/dsh-objective

[English](README.md) | 中文

注册 `objective` SessionProjection 的函数插件。它折叠原生 `agent-driver/objective` 全量快照，并把权威 DSH `goal/change` 事实适配为一个 Driver 中立值，且不额外发出事件。公共快照包含明确 owner、归一化 phase、可选 budget/attention/stop 事实，以及不透明的无损 JSON routing 数据；它刻意不定义公共 Goal id、revision 或 compare-and-set 操作。

## 组合

```yaml
- id: objective
  name: '@deepseek-ai/dsh-objective'
```

插件注入 `sessionProjections`。其 `./types` 与 `./client` 导出是供 Host 与 Client projection 消费者使用的纯类型入口。卸载插件只移除 projection 注册；静态已知的 `agent-driver/objective` 事件仍可从 Session 日志读取。

## DSH Goal 适配

有效的非 clear `goal/change` 映射为 owner `dsh`、Goal objective 与 phase、`goal-rounds` budget（`limit = maxGoalRounds`、`consumed = roundsStarted`）、blocked attention、完成 stop reason，以及包含 Goal id 与 revision 的 owner routing。clear tombstone 映射为 `null`。DSH Goal 的校验、revision、变更、activation 与 continuation 语义仍由 `@deepseek-ai/dsh-goal` 作为权威来源。

## 模型体验

无，因为插件只读取已经持久化的事实，不注册提示词段、消息、模型工具或 controller。

#### KV Cache 影响

无；插件从不组装或发送模型请求。

## 已知局限与延后工作

- Projection 只读；Driver 专属控制操作仍属于各自的 Driver 集成。
- 未知的原生 phase 细节放在事件嵌套的 Driver payload 中；便携 phase 保持在已记录的归一化集合内。
