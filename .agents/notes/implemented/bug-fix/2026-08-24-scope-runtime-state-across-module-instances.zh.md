# Agent Note: 跨模块实例的作用域运行时状态

Status: implemented

[English](2026-08-24-scope-runtime-state-across-module-instances.md) | 中文

## 问题

受支持的 [tsx 源码启动](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)会把工作区导入解析到 TypeScript 源码，而已安装的外部 Agent Driver（智能体驱动器）执行构建后的 JavaScript，并通过包 exports 解析对等依赖（peer dependency）。同一 JavaScript realm 因此可能由 Host 求值 `packages/core/scope/src/index.ts`，同时由 Driver 求值 `packages/core/scope/lib/index.js`。

作用域标识不只有上下文标签。父级关系控制 preset 继承，载体标记则控制带作用域的事件放行与 invariant 检查。如果每个模块实例分别拥有私有标签 symbol 和私有 `WeakMap`，Driver 可以创建一个有效且带作用域的 Agent Context，但 Host 会把它读成无作用域。随后，[`AgentPresets.mount()`](../architecture/2026-08-08-per-preset-standing-mounts.zh.md)会在发布前拒绝 setup，Agent 创建则回滚其尚未发布的 Session。只共享标签仍会让父级链接与载体识别彼此分离。

## 决策

在同一 JavaScript realm 中求值的每个兼容 `dsh-scope` 副本，都会从 `Symbol.for('@deepseek-ai/dsh-scope/runtime')` 键控的 `globalThis` slot 取得同一份内部 `ScopeRuntimeState`。首个副本创建 revision `1`，其中包含一个上下文标签 symbol、载体键映射和作用域父级映射；后续副本复用完整状态。副本若发现不同 revision，会在模块求值期间抛错，而不会使用只共享一部分的标识继续运行。

共享 slot 属于实现细节：公开函数签名与类型、配置、事件名称与载荷以及持久数据均不改变；跨副本查询与路由具备互操作性。worker、进程和其他 realm 各自保有独立状态。该包仍只为受信任的同进程插件提供路由，而不实施权限控制，具体定义见 [Agent 作用域决策](../architecture/2026-07-08-agent-scope-contexts.zh.md#security-and-authority-are-non-goals)。

本决策为[作用域运行时设计](../architecture/2026-07-12-agent-scope-runtime-design.zh.md)补充模块实例互操作性。它不改变 [TypeScript program 决策](../process/2026-07-22-tsconfig-solution-root-two-aggregates.zh.md)中的源码平面解析规则，也不改变使用该共享关系的 preset 作用域父链语义。

## 验证

- [`module-instances.spec.ts`](../../../../packages/core/scope/tests/module-instances.spec.ts) 通过两个源码模块 URL 求值两个实例：第二个实例读取第一个实例创建的标签，第一个实例读取第二个实例创建的父级与 rebind 状态，两个实例双向识别载体；该测试还证明 dispose 会等待异步清理完成，并覆盖 revision 不兼容时的失败。
- [`api-proxy-agent-driver-preset.spec.ts`](../../../../packages/host/apiproxy/tests/api-proxy-agent-driver-preset.spec.ts) 通过公开 API 和使用第二个作用域模块实例的非默认 Driver 创建 Session，观察 preset 组合与 Agent 发布，同时保留无作用域 Driver 的负向回滚用例。
- 外部 Driver 归档文件 SHA-256 `68cc7c6906872b090bcb1720a5cc8eafb6a6a784053d9f58fd07c783adb77b47` 的部署证据来自进程级冒烟测试：该测试在源码 Host 旁加载其已安装入口与 `CodexAgent`，验证 Driver 解析到 `dsh-scope/lib/index.js`，并观察 `session.create` 成功完成 preset 组合，全程不接触 Codex 传输。外部包不属于本仓库，因此该精确产物拓扑属于部署证据，而不是仓库内回归测试；上方两项仓库测试分别固定共享状态与调用点行为。

## 考虑过的替代方案

**由 Loader 规范化对等依赖导入。** Loader 层的单例策略必须为每个工作区对等依赖拥有源码与产物解析，而不只处理 `dsh-scope`，并且会与受支持的 tsx 源码解析器竞争。当拥有标识的包本身能让兼容副本互操作时，无需引入这项仓库级模块解析决策。

**仅通过 `Symbol.for()` 共享上下文标签 symbol。** 这会修复 `scopeOf()`，但 `bindScopeParent()`、`scopeChainOf()`、`isScopeCarrier()` 与 `carrierKeyOf()` 仍会读取模块私有映射。preset 继承和事件路由 invariant 仍取决于接收值的是哪一份副本。

**删除 preset 组合中的无作用域上下文检查。** 这会发布一个缺少所选 preset 提示词、工具、监听器与展示注册的 Agent。该检查用于识别不完整 setup，必须继续作为回滚门禁。

**要求使用构建后的 Host，或在外部 Driver 中硬编码源码包 URL。** 仅支持构建产物的启动方式会通过让 URL 重合来掩盖缺陷，并放弃受支持的源码启动器；仓库专属的绝对导入会使外部包失去可移植性。两者都不能为其他有效模块图建立互操作性。

## 后果

源码 Host 与构建后的外部 Driver 可以在同一 realm 内交换带作用域的 Context、父级关系与事件载体。以后若要改变共享状态的含义，必须显式更改 revision；参与该状态协议的不兼容副本会在模块求值时失败，而不会静默产生分歧。

代价是占用一个 well-known realm slot，并在 revision 不兼容时硬失败。该 slot 不跨越 worker 或进程边界，也不增强或削弱插件权限。Session 格式、协议字段、模型可见输入、配置键与公开 API 均不改变。
