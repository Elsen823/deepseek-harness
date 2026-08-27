# Agent Note: Agent 所有的 Turn 级模型选择

Status: implemented

[English](2026-08-25-agent-owned-turn-model-selection.md) | 中文

## Problem

Agent Driver 与 Host 必须看到同一个 Session 局部模型选择，包括首次模型请求前已接受的选择。把请求证据当作 intent 会丢失该选择，并混淆请求路由与 Driver 为某个 Turn 解析出的路由。Session 的选择也必须继续独立于未来 Session 使用的部署默认值。

## Decision

`ModelSelection` 只包含一个 DSH Model Provider、一个 provider 所有的 model，以及可选的 adapter 所有的 `reasoningEffort`。Service tier、Advanced Model Config、采样参数、工具、审批、沙箱策略、权限和原生 Driver 设置继续由各自所有者管理。

每个 live `Agent` 都携带一个 Session 局部的 `modelSelection` 所有者。Driver 在发布前为准确的 Session 构造该所有者，`AgentRegistry` 会拒绝不提供所有者的 Agent。选择 identity 不由 Host 局部 map、module 局部 map、prompt listener、request listener 或兼容 adapter 持有或路由。

所有者公开已接受的 `selected` intent、独立的 `effective` 证据、未提交的 `defaultSelection`、校验、接受、默认值更新和冻结的 `beginTurn()` 值。接受操作校验三个 Model Selection 字段，并立即以 `user` 或 `default` source 追加 `model/selected`；已接受的相同值不会重复追加。`beginTurn()` 只在 Turn 开始时实体化继承的默认值，解析一次适配器默认值，并返回一个冻结值。选择省略 effort 时不会保留较早模型的 effort。

内置 `dsh` Driver 会在提示词组装前捕获一次解析值，并将它提供给提示词变量以及该 Turn 的每个请求。接受操作与这次捕获串行化；运行中 Turn 的变更应用于下一 Turn，而 steering 继续使用已捕获的值。provider/model 不兼容会在模型 I/O 前校验，并且继承 default 只有在校验成功后才会提交，因此 recovery 可以修复路由而不改变已接受的 intent。Codex 直接构造相同的所有者，将每个冻结 Turn 映射到原生 identity，并在原生或 provider I/O 前拒绝不支持的 provider/model/effort 组合。

`Session` 在追加和恢复边界校验 `model/selected`，并将其与 `request/header` 和 `agent-driver/model-request` 证据分开折叠。`session.selectModel` 在被寻址的 Agent 与 Session 上接受 intent，但不改变部署默认值；空白 Session 在首次 Turn 实体化默认值之前读取 live 默认值。Web 展示区分 selected、next-turn、native、effective、DSH Session 和原生 conversation identity。TypeScript 与 Python SDK 保留该事件词汇并提供 selected-intent 投影，不会把生效请求证据当作 intent。

## Alternatives considered

**把选择存储在 Host 局部 map 中。** 从另一个已安装 package copy 解析出的 Driver 可能访问另一份 map。Agent 实例在 package copy 与生命周期调用方之间提供共享所有者。

**把请求证据作为 selected 值。** 请求记录的是已到达模型边界的路由，无法表示首次请求前接受的选择。`model/selected` 记录 intent，请求 header 与 Driver model-request 记录生效证据。

**让 Session 选择修改部署默认值。** 会话局部决定会静默改道无关的未来 Session。被寻址的 Session 所有者与部署默认值保持分离。

**把 service tier 或 Advanced Model Config 放入 `ModelSelection`。** 这些值分别属于适配器、设置或 Driver，并会让一个选择事件携带无关的请求控制项。选择事件只接受 provider、model、effort 与 source。

**通过 prompt assembly 或 request middleware 路由。** 这些 waterfall 组装或修改请求封套，无法保证原生与 DSH Turn 共用一个不可变路由。Agent 所有者在 Turn 开始时捕获并解析路由，然后 Driver 才执行模型 I/O。

## Consequences

已接受的选择即使没有被请求消费也能在恢复后保留，消费者可以区分它与最新生效的 provider/model/effort。每个现有 Agent Driver 都有一个显式所有者，缺少所有者的 Agent 会在发布时失败。重复的相同选择不会增长日志，省略 effort 也不会保留陈旧的 adapter 状态。Session 局部选择不会改道无关的未来 Session。

## Testing

Agent 测试覆盖所有者附着、发布拒绝、持久 intent、默认值实体化、冻结 Turn 值、重复选择空操作以及模型 I/O 前失败。DSH loop 测试覆盖提示词／请求 identity、单 Turn steering、effort 默认值清除、取消与准备失败证据、不可用路由和无密钥组装输出。Codex 测试覆盖直接构造所有者、原生路由映射、identity 投影和不支持的路由。Session 测试覆盖 selected/effective 的独立折叠、追加／恢复 payload 的错误校验以及同 Driver fork 保留。Host、TypeScript SDK 与 Python SDK 测试覆盖接受、校验和投影。无密钥组装与浏览器 fixture 断言 selected intent 先于首个生效请求证据。
