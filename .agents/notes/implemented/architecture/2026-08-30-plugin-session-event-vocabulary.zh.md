# Agent Note: 插件所有的 Session 事件词汇

Status: implemented

[English](2026-08-30-plugin-session-event-vocabulary.md) | 中文

## Problem

外部插件可以在编译期扩展 `SessionEventMap`，并在进程活跃时追加自己的事件，但生成的 `KNOWN_SESSION_EVENT_TYPES` 集合只包含本仓库中的声明。因此，持久化会在重启后拒绝每个外部事件。主 agent 驱动器需要 Session 绑定与原生 checkpoint 等必需持久事实，而 UI 和遥测集成也适合记录缺失后不会改变 Session 重建的观察事件。把每个外部事件都 patch 进 Harness 仓库，会让部署插件重新变成长期 fork；接纳所有未知事件，则会在缺少必需状态时静默恢复。

[事件词汇显式拒绝决策](../simplification/2026-08-25-fail-closed-session-event-vocabulary.zh.md)曾有意移除未使用的跳过标记，并把注册推迟到真实外部生产方能够定义必需与可选语义之时。外部主驱动器迁移提供了这一生产方，因此默认拒绝仍然必要，而被推迟的扩展机制现在得以具体化。

## Decision

**已知事件类型是仓库声明与 effect 作用域外部注册的并集。** `KNOWN_SESSION_EVENT_TYPES` 继续作为第一方声明的、与组合无关的生成集合。外部插件从自己的 Cordis 作用域为每个恢复时必须理解的事件调用 `ctx.sessions.registerEventType(type)`。名称必须以斜线限定，不能与第一方类型或另一项活跃注册冲突，并随所有者作用域卸载而消失。只有注册活跃时，持久化才接纳必需的外部事件；插件缺失时，Session 会以 `SessionFormatUnsupportedError` 拒绝，而不会用不完整状态重建。

**可选性是存储事件 envelope 上的断言。** 对于语义仅用于观察、且忽略后不会改变模型历史、请求重建、恢复、授权或另一项必需插件投影的事件，`Session.append()` 接受 `ignorable: true`。缺少该字段表示读取时必需。只有存储 envelope 携带字面量 `true` 时，协调器才接纳未注册事件；它绝不根据陌生名称推断安全性。reader 会逐字保留已接纳的可忽略事件，因此重新安装插件后仍可再次投影。

该 envelope 断言会经 seed 校验、JSONL 记录、Session Controller wire 历史与 SQLite 标量行保留。SQLite schema 20 为 `ignorable` 提供独立的 `0 | 1` 列，而不复用打包行判别字段；打包的第一方分片连续段要求该值为 `0`。在预发布政策下，`SESSION_FORMAT_VERSION` 继续保持 `0`：旧构建会对新 envelope 成员明确失败，SQLite 则拒绝每个旧 schema，而不是迁移。

必需的主驱动器 binding 与 checkpoint 事件不携带该标记，并在任何恢复前注册。驱动器活动、诊断或其他不参与重建的记录携带 `ignorable: true`。这种分类属于每个生产方的持久事件设计；该标记不是逃避恢复插件状态的兼容捷径。

## Alternatives considered

**把外部事件名生成进 Harness 已知集合。** 未采用，因为每次插件发布都将要求上游源码变更，而且即使消费方没有安装，构建也会声称自己理解该事件。

**接纳每个通过声明合并加入或以斜线限定的事件。** 未采用，因为 TypeScript 声明不会存在于持久 reader 进程中，而且命名语法不能证明忽略事件仍能保持重建正确。

**只在运行时注册上记录可选性。** 未采用，因为安全事实必须随持久记录传播。Session 可能被复制到没有 writer 插件的组合中，该 reader 必须在加载前就从持久数据区分必需数据和观察数据。

**要求可忽略事件也必须注册。** 未采用，因为声明插件缺席正是受支持的读取情形。活跃插件仍可注册其必需类型，而持久断言已经足以处理观察记录。

**用 Session header 的驱动器 id 决定加载哪组事件词汇。** 未采用，因为事件所有权不限于驱动器，多个独立插件都可以贡献持久事实，而且 header 判别字段会把核心 Session 身份耦合到单一扩展系列。

## Consequences

外部插件可以拥有持久状态，而无需把事件名加入 Harness 仓库。插件缺失时，必需状态仍然显式失败；观察历史则可以跨越插件移除继续读取。因此，同一个已存 Session 可能会依据活跃的必需事件注册而成功加载或拒绝，这是刻意的组合校验，不是格式猜测。

事件 envelope、传输与 SQLite schema 增加一个字段，每个后端都必须精确保留它。生产方必须为每次可忽略追加做出显式安全决策。核心测试固定注册所有权、重复与第一方类型拒绝、seed 校验和 append 默认值；共享持久化约定固定已注册必需事件的接纳、卸载后的拒绝及未注册可忽略事件的接纳；SQLite codec 与损坏测试固定标量往返和打包行拒绝。
