# Agent Note: 一致的 subagent 目录呈现过滤器

Status: implemented

[English](2026-08-30-subagent-catalog-filter.md) | 中文

## Problem

Web subagent 页头使用同一份保留的 Session Controller 目录来计算触发器数量、树行、展开状态、运行指示与懒加载决策。部署专用可见性策略，例如保留活跃后代、并在宽限期后隐藏旧 inactive 条目，过去需要 fork 该组件。只过滤行会让触发器数量与加载状态不一致；过滤 controller store 则会改变所有消费方的权威导航数据，并可能让隐藏的持久 Session 看起来像被删除。

按时间控制可见性还增加一项约束：即使没有 Host frame，投影也可能改变，因此 UI 需要一个显式的未来重算点，而不是把策略所有的 timer 分散进组件。

## Decision

`dsh-client-ui-subagent` 公开同步 `ui-subagent/catalog-filter` Cordis waterfall。输入包含根 Session id、兄弟切换器使用的可选当前 child id、保留目录与摘要，以及一个共享 `now` 样本。监听器调用 `next()` 继续组合，或返回 `SubagentCatalogFilterResult`，其中包含彼此一致的投影目录、投影摘要，以及从同一投影派生的后代索引。默认结果返回完整保留目录与摘要。

结果可以提供 `nextExpirationAt`，即保留状态不变时投影下一次可能变化的未来时刻。页头拥有一个有界 timeout，在该时刻刷新共享 `now` 样本，并随组件 dispose 该 timeout。因此，普通活跃耗时 tick 与策略过期使用同一份投影输入。

过滤器仅影响呈现。它不修改 Session Controller 状态、不改变 Session 持久化、不改变 `@` 引用发现，也不删除隐藏 Session。每次 render 的数量、活动、树渲染与行加载决策都消费同一结果。若插件返回互不一致的目录、摘要或后代总数，就违反了事件约定；core 不合并独立过滤的片段。

该事件保持同步，因为它在 React 派生期间运行，且所有输入都已保留在内存中。需要远程数据的插件必须先把数据发布到自己的客户端状态，再执行过滤，而不是挂起目录 render。

## Alternatives considered

**过滤 Session Controller 的保留目录。** 未采用，因为 controller 是页头之外也会使用的权威共享状态；呈现策略不能改变发现、导航、刷新或持久化语义。

**为触发器数量、行和加载分别公开 hook。** 未采用，因为独立组合的投影可能在同一次 render 中互相矛盾，产生数量非零却没有行的触发器，或为刻意隐藏的条目显示加载占位符。

**把过滤器改为异步。** 未采用，因为 render 时挂起会为内存投影增加闪烁与取消状态。外部数据获取应发生在这一纯呈现步骤之前。

**让每个插件拥有自己的 interval。** 未采用，因为多项策略会创建重复 timer 和不同的 `now` 样本。只保留最早声明的过期点，可以使重算受生命周期约束且保持确定性。

## Consequences

可见性行为可以作为外部浏览器插件交付，而无需 fork Harness，默认 UI 行为则保持不变。过滤器作者必须在产品需要时保留当前 Session 导航，并从投影摘要计算后代总数。过去时刻或反复不变的过期值会造成无意义重算，因此生产方负责只返回下一次未来变化。

客户端测试固定 identity 默认值、waterfall 注入、一致的数量与树消费，以及 timer 生命周期。包 README 负责公开过滤器约定；Host Cordis 目录有意豁免这一 client-face 事件，而客户端包导出其输入、结果与完整目录 helper。
