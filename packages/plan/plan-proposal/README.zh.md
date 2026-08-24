# @deepseek-ai/dsh-plan-proposal

[English](README.md) | 中文

注册 `proposedPlan` SessionProjection 的函数插件。它把 `agent-driver/proposed-plan` 折叠为一个全量持久文档，包含 branded id、owner、标题、Markdown 内容、生命周期（`proposed`、`accepted`、`rejected` 或 `superseded`），以及可选 relation/routing 数据；owner 清除当前文档时则折叠为 `null`。

Proposed Plan 与 Plan Mode、Checklist 状态相互独立：Plan Mode 控制协作指引，Checklist 报告当前工作，而本包暴露供评审或后续实现使用的完整文档。

## 组合

```yaml
- id: plan-proposal
  name: '@deepseek-ai/dsh-plan-proposal'
```

插件注入 `sessionProjections`。其 `./types` 与 `./client` 导出是供 Host 与 Client projection 消费者使用的纯类型入口。卸载插件只移除 projection 注册；静态已知的持久文档事件仍可读取。

## 模型体验

无，因为本包不提供计划 controller、提示词指引、评审工具或模型可见消息。

#### KV Cache 影响

无；它从不组装或发送模型请求。

## 已知局限与延后工作

- 生命周期策略由 owner 决定。便携 projection 记录全量快照，不施加公共 transition controller。
- 本包仅暴露最新文档快照；历史生命周期事实保留在 Session 日志中。
