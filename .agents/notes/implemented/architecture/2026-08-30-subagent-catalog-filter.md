# Agent Note: Coherent subagent catalog presentation filter

Status: implemented

English | [中文](2026-08-30-subagent-catalog-filter.zh.md)

## Problem

The Web subagent header consumes one retained Session Controller catalog for its trigger count, tree rows, disclosure state, running indicator, and lazy-loading decisions. A deployment-specific visibility policy, such as retaining active descendants while hiding old inactive entries after a grace period, previously required a fork of the component. Filtering only rows would leave the trigger count and loading state inconsistent; filtering the controller store would alter authoritative navigation data for every consumer and could make a hidden durable Session appear deleted.

Time-based visibility adds another constraint: the projection can change without a Host frame, so the UI needs one explicit future recomputation point rather than policy-owned timers scattered through the component.

## Decision

`dsh-client-ui-subagent` exposes the synchronous `ui-subagent/catalog-filter` Cordis waterfall. Its input contains the root Session id, the optional current child id used by the sibling switcher, the retained catalogs and summaries, and one shared `now` sample. A listener calls `next()` to compose or returns a `SubagentCatalogFilterResult` containing coherent projected catalogs, projected summaries, and the descendant index derived from that same projection. The default returns the complete retained catalog and summaries.

The result may provide `nextExpirationAt`, the next future wall-clock instant when the projection can change without retained state changing. The header owns one bounded timeout, refreshes the shared `now` sample at that point, and disposes the timeout with the component. Ordinary active-duration ticks and policy expiry therefore drive the same projection input.

The filter is presentation-only. It does not mutate Session Controller state, alter Session persistence, change `@` reference discovery, or delete hidden Sessions. Counts, activity, tree rendering, and row-loading decisions consume one result per render. A plugin that returns inconsistent catalogs, summaries, or descendant totals violates the event contract; core does not merge independently filtered fragments.

The event stays synchronous because it runs during React derivation and all inputs are already retained in memory. Plugins that need remote data must publish it into their own client state before filtering rather than suspend the catalog render.

## Alternatives considered

**Filter the Session Controller's retained catalogs.** Rejected because the controller is authoritative shared state used beyond this header; presentation policy must not change discovery, navigation, refresh, or persistence semantics.

**Expose separate hooks for trigger count, rows, and loading.** Rejected because independently composed projections can disagree within one render, producing a nonzero trigger with no rows or loading placeholders for intentionally hidden entries.

**Make the filter asynchronous.** Rejected because render-time suspension would add flicker and cancellation state for an in-memory projection. External data acquisition belongs before this pure presentation step.

**Let each plugin own an interval.** Rejected because multiple policies would create redundant timers and different `now` samples. One earliest declared expiration keeps recomputation lifecycle-bound and deterministic.

## Consequences

Visibility behavior can ship as an external browser plugin instead of a Harness fork, while the default UI remains behaviorally unchanged. Filter authors must preserve current-session navigation where their product requires it and must compute descendant totals from the projected summaries. A past or repeatedly unchanged expiration can cause needless recomputation, so producers are responsible for returning only their next future change.

Client tests pin the identity default, waterfall injection, coherent count and tree consumption, and timer lifecycle. The package README owns the public filter contract; Host Cordis catalogs intentionally exempt this client-face event, while the client package exports its input, result, and complete-catalog helper.
