# @deepseek-ai/dsh-todo

[English](README.md) | 中文

`todos` SessionProjection 的可移植 Service Provider。它从核心 Session 事件派生当前完整 Checklist（检查清单），不提供模型工具、变更控制器，也不依赖 `ctx.tools`。

## 投影语义

提供方在 `ctx.sessionProjections` 上注册唯一的 `todos` 单元。空日志的值是 `null`；每个 `todo/write` 都用事件携带的完整 `TodoItem[]` 替换当前值；`turn/start` 将其清为 `null`；`turn/end` 和无关事件保留同一状态引用。因此，完成后的 Checklist 会一直可见，直到下一轮次开始。

wire 视图就是状态本身。`stateVersion` 保持为 `2`，因为包迁移没有改变序列化状态或折叠语义。本包拥有 `SessionProjectionMap.todos`、`SessionProjectionStateMap.todos` 声明，以及用于校验缓存状态和 wire 值的 Zod schema。

注册具有 effect scope：卸载会移除投影并释放提供方所有权。同一注册表上的第二个提供方挂载会失败，不会共享或替换现有提供方。

## 组合

```yaml
- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: todo
  name: '@deepseek-ai/dsh-todo'
```

`@deepseek-ai/dsh-tool-todo` 是可选 Consumer。仅在需要模型通过 `todo_write` 修改 Checklist 时单独挂载它。

## 模型体验

无，因为本提供方只折叠已经记录的 Session 事件，不注册 prompt section、工具 schema、模型消息、流中间件或工具结果。

#### KV Cache 影响

无；本提供方不会组装或发送模型请求。

## 已知限制与暂缓事项

- **仅支持整表事件**：折叠要求每个 `todo/write` 都携带完整替换列表，不合并单项增量。
- **按轮次限制可见期**：下一次 `turn/start` 会清空 Checklist，包括没有进入模型 step 就结束的轮次。
