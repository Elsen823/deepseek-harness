# Agent Note: Web 模型选择身份

Status: implemented

[English](2026-08-25-web-model-selection-identities.md) | 中文

## 问题

Web 选择器编辑一个 DSH 会话，但正在运行的 Turn 仍可能使用较早接受的选择。Codex 支持的会话还拥有不同于 DSH 路由的原生模型和会话身份。把这些值合并为一个模型标签会隐藏更改是否待处理、哪个身份真正到达模型，以及 Driver 所有的原生会话。

## 决策

Runtime 将持久化的 `model/selected`、`request/header`、`agent-driver/model-request` 与 Driver 激活证据折叠为会话级 `ModelSelectionIdentity` 投影。`Selected` 是最近接受的 DSH 提供方／模型及可选的适配器所有推理强度；`Effective` 是最近的请求证据；只有接受值不同于最近生效值时才显示 `Next turn`。该折叠独立携带 DSH 会话 ID 与可选的原生会话 ID，并且仅在 Driver 证据提供时携带原生模型／推理强度。

ui-model-selection 插件在会话标题栏将这些值呈现为独立的 `Selected`、`Next turn`、`Effective`、`Native`、`DSH Session` 与原生会话行。Reasoning Effort 仍是 DSH 或原生选择的属性，不会作为模型呈现。因此 Turn 运行期间作出的选择会保留当前 Effective 行，并将接受值标记为 `Next turn`，直到后续请求证据采用该值。

选择器仍然按会话隔离：`session.selectModel` 在请求中寻址 Agent 与会话，而 Models 设置负责未来会话或尚未提交的空白会话默认值。目录会保留 Driver 无法表示的模型和推理强度行，并显示原因及停用状态；当前提供方路由不可用时仍保持可用，让用户可以选择兼容行来恢复。目录状态按会话 ID 作用域隔离，因此并行会话保留独立选择；重连和重新加载会在首次请求前恢复 Host 状态。

## 考虑过的替代方案

**把 DSH 与原生身份合并为一个模型标签。** 原生 Driver 可以把 DSH 路由映射到不同的原生模型或会话，因此合并标签会使一致与偏离都无法检查。

**只显示最近一次生效请求。** 这会丢失首次请求前的已接受选择，并隐藏运行中 Turn 的待处理更改。持久化的 Selected 投影与派生的 Next turn 行保留这两个事实。

**把 Reasoning Effort 当作另一个模型。** 推理强度是 DSH 或原生选择上的适配器所有元数据，而不是路由身份。保持独立行可以防止提供方／模型标签把推理强度误称为模型。

**当前提供方不可用时停用选择器。** 恢复需要用户选择可服务的路由，因此选择器保持交互可用，同时 composer 可用性阻塞块传达当前路由故障。

**把选择器选择写入部署默认值。** 会话级更改不能重定向其他会话或未来空白会话；Models 设置仍是唯一默认值所有者。

## 影响

Web 用户可以分别检查 DSH 会话、接受意图、待处理的下一 Turn 值、生效请求、原生 Driver 映射与原生会话。投影可以由会话事件窗口重建，不添加模型可见输入。在 Driver 发出证据前不显示原生行；当新选择等待下一次请求时，生效行可以保持不变。

## 测试

Runtime 与组件测试固定独立的 Selected／Next turn／Effective 折叠、原生及会话身份、Reasoning Effort 不作为模型，以及无关事件下投影引用稳定。browser-plugin 测试通过真实客户端插件注册路径覆盖两个并行会话、首次请求前重新加载、提供方故障恢复、不兼容行与运行中 Turn 的转换。位于 [`apps/web/tests/model-selection-identities.snapshot.ts`](../../../../apps/web/tests/model-selection-identities.snapshot.ts) 的无密钥 assembled browser 快照挂载会话级标题栏和选择器约定，并记录内置 DSH 身份标签。

## 暂缓

Driver 专属的 Activity 布局可以补充更丰富的原生诊断，但仍消费相同的 DSH 会话与原生身份字段。跨 Driver 的身份映射仍由各 Driver 所有；Web 模型选择包不会根据目录名称推断别名或原生会话 ID。
