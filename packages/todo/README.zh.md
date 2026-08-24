# todo/：Checklist 能力家族

[English](README.md) | 中文

可移植 Checklist 投影及其可选的模型侧 Consumer。核心 Session 拥有 `TodoItem` 和 `todo/write`；本组拥有读取侧投影提供方，以及生成经过校验的整表写入的工具。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`todo/`](todo/README.zh.md) | `todos` SessionProjection 的 Service Provider；不提供工具或变更控制器。 | （注册到 `ctx.sessionProjections`） |
| [`tool-todo/`](tool-todo/README.zh.md) | 面向模型的 `todo_write` Consumer、校验器和执行器。 | （注册到 `ctx.tools`） |

每个 SessionProjection 注册表只能组合一个提供方。Consumer 是可选的，并且可以独立设置 scope。事件载荷记录在 [docs/subsystems/session.md](../../docs/subsystems/session.zh.md)。
