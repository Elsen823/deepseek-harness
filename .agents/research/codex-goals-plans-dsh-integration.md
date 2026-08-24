# Codex native goals and plans in DeepSeek Harness

## Scope and source baseline

This report compares Codex 0.149.0 and current app-server goal/plan behavior with the current DeepSeek Harness goal, plan-mode, todo, Agent, Session, SDK, and Web models. It evaluates three integration strategies and the proposal to add Codex-specific values to core `AgentStatus`.

Sources are limited to official OpenAI Codex source/documentation and the checked-out DSH source:

- Codex 0.149.0 release [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0), commit [`758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`](https://github.com/openai/codex/commit/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0).
- Current Codex upstream at research time, [`c9b19deb09c1841ce7acc33ddb96276030936a29`](https://github.com/openai/codex/commit/c9b19deb09c1841ce7acc33ddb96276030936a29).
- Official [Codex app-server documentation](https://developers.openai.com/codex/app-server) and [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform).
- Current files under `/home/elsen_xu/deepseek-harness`; no generated or secondary description is treated as authority over its owning source.

The goal protocol, goal persistence/runtime, plan protocol types, and proposed-plan item behavior examined here are materially identical at the two Codex commits. The core plan handler has no semantic change relevant to this report; a tooling-output method was renamed. See the official [0.149.0…current comparison](https://github.com/openai/codex/compare/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0...c9b19deb09c1841ce7acc33ddb96276030936a29).

## Executive recommendation

Choose **option 3: driver-neutral projections with explicit execution ownership**, introduced in stages.

For the first resident Codex integration, let Codex own native goal persistence, accounting, continuation, collaboration mode, checklist updates, and proposed-plan items. Do not also compose DSH's goal-round driver, goal mutation tools, plan prompt/review controller, or todo mutation tool for that Codex-owned thread. Project Codex activity into DSH for replay and UI, but do not issue a second set of commands against a mirrored DSH state machine.

Reuse existing DSH durable values only where the semantics are exact:

- Codex `update_plan` is semantically closest to DSH `todo/write`, not `plan/mode`: both are whole-list checklist snapshots with `pending`, `in_progress`, and `completed` states. A Codex adapter can durably record observed snapshots as DSH todo state after mapping `inProgress` to `in_progress`, provided the DSH todo tool itself is disabled for that driver.
- Codex Plan collaboration mode can project to a generic collaboration-mode value. DSH's current `plan/mode` event is a suitable boolean value, but its package currently also owns prompt injection, the `exit_plan_mode` tool, and review workflow. Split read projection from execution before treating it as driver-neutral.
- Codex final `ThreadItem::Plan` is a proposed-plan document, a third concept not represented by DSH `plan/mode` or `todo/write`. Give it a distinct durable conversation item/event and renderer.
- Do **not** translate native Codex goals into DSH `goal/change`. The two goal state machines have different identity, revision, budget, stop, persistence, authority, and restart semantics. Present them through a driver-neutral objective projection with an explicit execution owner and an adapter-owned command face.

Keep core `AgentStatus` as the binary quiescence interface, `'idle' | 'running'`. Represent waiting for approval/input, collaboration mode, goal state, and terminal turn/subagent outcome on orthogonal projections. Codex itself separates those axes; adding Codex product strings to DSH's quiescence type would create ambiguous scheduling behavior and break Web/SDK consumers that assume exact binary states.

## Codex native goals

### Protocol and stability

App-server exposes three goal methods and two notifications:

```text
thread/goal/set
thread/goal/get
thread/goal/clear
thread/goal/updated
thread/goal/cleared
```

The request methods are serialized per thread. They are deliberately not annotated with `#[experimental]`, and protocol tests assert that the methods and notifications are not experimental-API gated ([request/notification registry and tests](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/common.rs#L562-L576), [non-experimental assertions](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/common.rs#L4257-L4318)).

`Feature::Goals` is documented in source as “persisted thread goals and automatic goal continuation,” has `Stage::Stable`, and is enabled by default. A deployment may still disable it, in which case goal requests fail with `goals feature is disabled` ([feature registry](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/features/src/lib.rs#L280-L282), [stable/default setting](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/features/src/lib.rs#L1406-L1411), [request guard](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L104-L111)).

This stability statement is about the goal capability. OpenAI still describes the app-server command and WebSocket transport as experimental/not supported for production workloads ([official app-server guide](https://developers.openai.com/codex/app-server)).

### Wire type

`ThreadGoal` contains:

```text
threadId
objective
status
optional tokenBudget
tokensUsed
timeUsedSeconds
createdAt
updatedAt
```

Its statuses are:

```text
active
paused
blocked
usageLimited
budgetLimited
complete
```

`thread/goal/set` accepts optional `objective`, optional `status`, and a three-way token-budget field: absent keeps the budget, number sets it, and `null` clears it. `thread/goal/get` returns a goal or `null`; clear returns `{ cleared: boolean }` ([v2 goal types](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L761-L864)).

The app-server type omits Codex's internal `goal_id`. A client sees neither a stable goal identity nor a revision/CAS token. It therefore cannot losslessly manufacture DSH's `{ id, revision }` semantics from the Codex response.

A `thread/goal/updated` notification carries `threadId`, optional `turnId`, and the complete goal value. Goal mutations attributed to a running turn carry its `turnId`; external RPC mutations and resume snapshots use `null`. `thread/goal/cleared` carries only `threadId` ([notification types](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1884-L1898)).

Objectives must be non-empty and no longer than 4,000 characters ([core goal validation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/protocol/src/protocol.rs#L3819-L3830)). Token budgets must be positive and may be capped by `max_goal_token_budget` ([goal tool validation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/tool.rs#L347-L370)).

### Mutation authority

Codex supplies model tools named `get_goal`, `create_goal`, and `update_goal` when goals are enabled and persistent goal state is available. `create_goal` instructs the model to act only on an explicit user/system/developer request. Model `update_goal` can set only `complete` or `blocked`; pause, resume, budget-limit, and usage-limit are user/system operations. Its blocked policy requires the same blocker for at least three consecutive goal turns ([goal tool specifications](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/spec.rs)).

App-server clients are more powerful than the model tools: `thread/goal/set` accepts every status. There is no goal revision field or per-caller authority token in that request. Multi-client authorization is therefore an app-host responsibility, not a property of the goal state machine.

### Persistence

Goals require a persisted thread. Goal RPC rejects an ephemeral thread and rejects a missing thread or missing SQLite state database ([materialized-thread check](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L228-L262)). This means DSH's current one-shot Codex subagent—whose app-server thread is explicitly ephemeral—cannot use native Codex goals.

The authoritative store has one `thread_goals` row per `thread_id` with internal `goal_id`, objective, status, token budget, token/time usage, and timestamps ([goal schema migration](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/goals_migrations/0001_thread_goals.sql)). Deleting the goal deletes that row. Thread goal updates are also persisted as `EventMsg::ThreadGoalUpdated` rollout items, enabling state reconciliation; goal clear is a database delete plus a live `thread/goal/cleared` notification rather than a `ThreadGoalCleared` rollout item ([rollout persistence policy](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/policy.rs#L86-L105), [clear processing](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L196-L226)).

On resume, app-server emits the current goal snapshot or a cleared notification after the thread listener is ready. A consumer should call `thread/goal/get` or accept that resume snapshot as authority rather than attempt to fold only historical update notifications ([resume snapshot](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L796-L821)).

The current official docs say that supplying a new objective replaces the goal and resets usage, but the examined 0.149/current `GoalService::set_thread_goal` updates an existing row in place, preserving its internal goal id and usage; the TUI obtains replace-and-reset behavior by explicitly clearing before setting a replacement. Integrations should test the server implementation they ship rather than infer reset behavior from objective inequality ([goal service set behavior](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/api.rs#L127-L242), [TUI clear-before-replace](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/tui/src/app/thread_goal_actions.rs#L181-L208), [official prose](https://developers.openai.com/codex/app-server#manage-a-thread-goal)).

### Accounting and continuation

While a goal is active, Codex accounts non-cached input tokens plus output tokens and wall-clock seconds. It accounts at tool-completion and turn boundaries and changes an active goal to `budgetLimited` when usage reaches the token budget. A usage-limit failure changes an active or budget-limited goal to `usageLimited`; other terminal turn errors block it ([accounting implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/accounting.rs), [turn/error hooks](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/extension.rs#L184-L306)).

When a thread becomes idle, an active goal starts another turn with an internal goal-continuation context item. Paused, blocked, usage-limited, budget-limited, and complete goals do not continue. Resuming an active goal through the external RPC can immediately start work if the thread is idle ([idle continuation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/runtime.rs#L358-L438), [continuation prompt](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/templates/goals/continuation.md)).

Goal continuation is not represented by a persisted round number. The runtime knows the active goal id for current accounting, and `thread/goal/updated.turnId` can attribute updates to a turn, but the public goal contains no admitted-round count or continuation generation.

A Plan collaboration-mode turn is excluded from active-goal token accounting and clears that turn's active-goal marker. The goal's persisted status itself remains unchanged ([Plan-mode accounting exclusion](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/extension.rs#L195-L238), [accounting flag](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/accounting.rs#L65-L86)).

### Forks and multi-agent work

A thread fork copies the source goal snapshot—including internal goal id, status, usage, budget, and timestamps—to a new independent row keyed by the forked thread id. With experimental `deferGoalContinuation`, the fork writes a durable deferral marker so its active goal does not auto-start until the first explicit turn consumes the marker. Source and fork rows then evolve independently ([fork copy](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_fork_goal.rs), [deferral migration](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/goals_migrations/0002_thread_goal_continuation_deferrals.sql), [fork/resume test](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/tests/suite/v2/thread_fork.rs#L844-L976)).

Goal storage is thread-scoped, not agent-tree-scoped. There is no aggregate parent/child goal method. Ordinary persistent subagent threads can receive their own goal tools; review subagents explicitly do not receive them. A parent's goal is not an automatically shared multi-agent work ledger ([tool availability](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/ext/goal/src/extension.rs#L76-L122)).

## Codex plans: three separate concepts

Codex uses “plan” for three unrelated values. DSH integration must keep them separate.

### 1. Plan collaboration mode

Plan mode is a collaboration mode selected for a turn. The prompt forbids mutating work, encourages repository exploration and user questions, and requires the final plan inside a `<proposed_plan>` block. It explicitly states that Plan mode and `update_plan` are separate and that `update_plan` must not be used while in Plan mode ([Plan collaboration template](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/collaboration-mode-templates/templates/plan.md)).

The old `collaboration_modes` feature flag is retained only for compatibility: its feature stage is `Removed` because collaboration modes are now always enabled ([feature registry](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/features/src/lib.rs#L343-L345), [feature spec](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/features/src/lib.rs#L1430-L1435)).

### 2. `update_plan` checklist

`update_plan` accepts an optional explanation and a complete list of `{ step, status }` entries. Status is `pending`, `in_progress`, or `completed` at the model-tool interface and `pending`, `inProgress`, or `completed` on the app-server wire. The tool description asks for at most one `in_progress` item, but the handler only parses the typed list; it does not enforce that count ([tool argument types](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/protocol/src/plan_tool.rs), [tool schema](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/tools/handlers/plan_spec.rs), [handler](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/tools/handlers/plan.rs)).

Each accepted call emits a thread-scoped `turn/plan/updated` notification containing `threadId`, `turnId`, explanation, and the complete plan list ([wire type](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L423-L465), [notification mapping](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/bespoke_event_handling.rs#L1264-L1283)).

`PlanUpdate` is explicitly classified as a transient, non-durable rollout event. It is not a `ThreadItem`, there is no plan get/list/update RPC, and resume does not replay a current checklist snapshot. A host that wants reconnect/replay must persist its own observation ([rollout policy](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/policy.rs#L122-L183)).

### 3. Proposed-plan item

In Plan collaboration mode, Codex parses `<proposed_plan>` text out of the model stream. It emits a `ThreadItem::Plan { id, text }` lifecycle: `item/started`, zero or more `item/plan/delta`, and authoritative `item/completed`. The final item may differ from concatenated deltas ([plan item type](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L257-L264), [parser](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/utils/stream-parser/src/proposed_plan.rs), [app-server test](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/tests/suite/v2/plan_item.rs)).

The source comments label the proposed-plan item and delta **EXPERIMENTAL**, although they are present in the normal generated protocol and are not decorated with an experimental capability annotation. The completed Plan item is persisted even in legacy rollout history, while plan deltas are transient ([item comment](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L257-L264), [persistence policy](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/policy.rs#L86-L98)).

### `PlanType` is not a work plan

The generated `PlanType` union—`free`, `plus`, `pro`, `business`, `enterprise`, and so on—is the user's ChatGPT subscription/account tier. It is unrelated to collaboration Plan mode, checklist steps, or proposed-plan items ([account plan type](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/schema/typescript/PlanType.ts), [official auth documentation](https://developers.openai.com/codex/app-server#authentication-modes)).

### Multi-agent plan behavior

Checklist updates and proposed-plan items carry one `threadId` and one `turnId`. They are not aggregated across parent and child agents. Codex's MultiAgent V2 forwards a child's terminal result to its parent, but that is a separate inter-agent completion path; it does not turn child plan updates into a parent plan ([parent completion forwarding](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/session/mod.rs#L1958-L2073)).

## Current DSH semantics

### DSH Goal

DSH Goal is an event-sourced, same-session state machine. Every non-clear `goal/change` event carries a complete `GoalSnapshot`; clear records a revisioned tombstone. A goal has a globally generated `GoalId`, positive CAS revision, objective, phase, optional structured block reason, and `maxGoalRounds`. Replay derives admitted round count and timestamps from the session log ([goal types](../../packages/goal/goal/src/types.ts#L15-L100), [durable change vocabulary](../../packages/goal/goal/src/domain.ts#L13-L82)).

Its phases are only `active`, `paused`, `blocked`, and `complete`. Provider limits, execution errors, and budget conditions are intended to be blocker reasons or policy outside the lifecycle, not additional phase strings ([Goal README](../../packages/goal/goal/README.md#service-contract)).

The Session log is the only durable authority. Every mutation uses `{ id, revision }` compare-and-set. Activation—whether the current process may automatically continue—is explicitly process-local and is disarmed on every session-start/resume edge. An explicit resume mutation must rearm it ([Goal service](../../packages/goal/goal/src/index.ts#L182-L213), [create/edit/resume](../../packages/goal/goal/src/index.ts#L244-L328), [replay cache](../../packages/goal/goal/src/index.ts#L420-L447)).

The goal-round driver schedules exact numbered continuation messages only after agent idle/checkpoint conditions, reserves one round identity, handles queued competitors, and revalidates at pre-step admission. A positive round is durable only when its goal-sourced `user/message` enters the Session log ([driver state and reservation](../../packages/goal/goal-round-driver/src/index.ts#L21-L74), [continuation scheduling](../../packages/goal/goal-round-driver/src/index.ts#L96-L205), [pre-step fences](../../packages/goal/goal-round-driver/src/index.ts#L333-L414)).

DSH model authority also differs from Codex. Goal mutation tools require the exact live running initiator and open turn. Create/edit/pause/resume require direct human authority; complete/blocked accept either direct human authority or the exact admitted goal round, and blocked records an explanation and enforces the configured minimum round count ([goal tool authority](../../packages/goal/tool-goal/src/authority.ts#L29-L107), [goal mutation tool](../../packages/goal/tool-goal/src/index.ts#L186-L326)).

### DSH Plan mode

DSH `plan/mode` is a durable per-session boolean collaboration mode, not plan content or checklist progress. The last event wins. While active, DSH injects deployment-owned guidance and offers `exit_plan_mode`; exit presents a complete Markdown plan to the user and records inactive mode only after approval. Sandbox and approval policy are independent ([plan-mode module](../../packages/plan/plan-mode/src/index.ts#L1-L18), [event type](../../packages/plan/plan-mode/src/index.ts#L46-L55), [review/exit flow](../../packages/plan/plan-mode/src/index.ts#L342-L430)).

The package also holds a process-local pending intent while an agent is running and commits it at an accepted pre-step. Its `PlanProjection` exposes only `{ active, pending }` ([plan projection type](../../packages/plan/plan-mode/src/types.ts#L11-L28), [Plan README](../../packages/plan/plan-mode/README.md#durable-state)).

This combines projection, command/controller, prompt, and exit-review ownership in one module. It is therefore not yet a driver-neutral read model that a native Codex adapter can use without also introducing DSH execution semantics.

### DSH Todo is the checklist match

DSH `todo/write` carries a complete ordered list of `{ content, status }`; status is `pending`, `in_progress`, or `completed`. The latest snapshot wins, and the Web projection clears it at the next `turn/start` so the just-finished checklist remains visible between turns ([Session Todo type/event](../../packages/core/session/src/types.ts#L180-L195), [todo tool and projection](../../packages/todo/tool-todo/src/index.ts#L122-L147)).

The DSH tool may allow several `in_progress` tasks or enforce at most one as a deployment choice. Its durable invariant deliberately does not encode that policy. This makes the durable value compatible with Codex's full checklist list, even though Codex's model description asks for a single active item ([todo configuration](../../packages/todo/tool-todo/src/index.ts#L28-L38), [validation](../../packages/todo/tool-todo/src/index.ts#L80-L110)).

The current Web already renders this projection as the standing checklist/plan strip ([Todo panel](../../packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx#L1-L22), [projection adapter](../../packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx#L130-L153)).

### Session projections and Web

DSH's projection registry drives pure synchronous folds over committed Session events, validates wire values, sends whole-value changes, and treats caches as replaceable fold shortcuts rather than authority ([projection definition](../../packages/session/session-projection/src/index.ts#L34-L81), [snapshot/cache semantics](../../packages/session/session-projection/src/index.ts#L84-L126)). This is the appropriate module for driver-neutral read models, provided the adapter first commits an authoritative DSH Session event.

The existing Goal bar assumes the DSH goal identity/revision/phase vocabulary and invokes DSH edit/pause/resume/clear callbacks. It cannot safely receive a native Codex goal without a new command adapter or a driver-neutral display type ([Goal bar](../../packages/client/ui-goal/src/client/GoalBar.tsx#L22-L78), [actions](../../packages/client/ui-goal/src/client/GoalBar.tsx#L126-L184)). The Plan chip only reads `{ active, pending }` and calls the DSH `/plan off` path ([Plan control](../../packages/client/ui-plan/src/client/PlanModeControl.tsx#L14-L69)).

### Current Codex provider

The checked-in DSH Codex provider launches a new `codex app-server --stdio` process for every one-shot run and creates an ephemeral thread ([run lifecycle](../../packages/subagent/subagent-codex/src/run.ts#L219-L254)). Native Codex goals reject that thread type. Its wire handler consumes `agentMessage` from `item/completed` and ignores other item types, so it currently discards proposed-plan items and `turn/plan/updated` activity ([notification handling](../../packages/subagent/subagent-codex/src/wire.ts#L673-L718)).

A resident persistent-thread Codex Agent adapter is therefore a new owner, not a small extension of the one-shot subagent result parser.

## Semantic comparison

| Concern | Codex native goal | DSH Goal |
|---|---|---|
| Durable owner | Codex goal SQLite row, with update snapshots in rollout | DSH Session `goal/change` log |
| Identity | Internal `goal_id`, omitted from app-server wire | Public `GoalId` + positive CAS revision |
| Unit | One goal per Codex thread | One current goal per DSH Session |
| Lifecycle | active, paused, blocked, usage-limited, budget-limited, complete | active, paused, blocked, complete |
| Budget | token and elapsed-time accounting | admitted-round cap |
| Block details | status only | structured code + message |
| Continuation | active goal automatically starts when thread is idle | active **and armed**; resume/hot-load disarms until explicit rearm |
| Continuation identity | no public round number | exact goal id/revision/round in admitted message source |
| Mutation concurrency | per-thread request serialization, no public CAS | compare-and-set ref on every mutation |
| Turn attribution | optional `turnId` on updates | mutation event position plus goal-round message source |
| Fork | copies snapshot/internal id and may defer initial continuation | copies log state but activation is disarmed |
| Model authority | create; complete/blocked updates | create/edit/pause/resume under direct-human authority; complete/blocked under direct-human or exact round |

The field overlap is superficial. Translating Codex status into DSH `GoalSnapshot` would require inventing an id, revision, max rounds, blocked reason, and activation state while discarding token/time accounting and Codex's independent continuation owner.

| “Plan” concern | Codex | Closest DSH concept |
|---|---|---|
| Collaboration mode | Plan turn mode and native prompt | `plan/mode`, but current package also owns execution |
| Progress checklist | transient `turn/plan/updated`, full list | durable `todo/write` |
| Final plan document | persisted experimental `ThreadItem::Plan` | no dedicated durable plan document type |
| Account `PlanType` | subscription tier | no planning meaning |

## Integration options

### Option 1 — Disable DSH Goal/Plan execution for Codex and render native activity

**Implementation:** Codex owns goals, continuations, Plan mode, checklists, and proposed-plan items. DSH stores enough observed events to render/replay them, but exposes no DSH goal/plan mutation tools for those sessions.

**Benefits:**

- One execution owner and one continuation scheduler.
- Exact Codex semantics, including token accounting and multi-client updates.
- Smallest risk of duplicate turns, contradictory goal phases, or two plan prompts.

**Costs:**

- Provider-specific UI/types if no neutral projection is introduced.
- DSH automation cannot use one uniform mutation interface.
- Native checklist updates need a DSH durable observation if reconnect/replay matters because Codex does not persist `PlanUpdate`.

**Assessment:** Best safe first milestone, but not the best final architecture if more than one driver will expose goals or plans.

### Option 2 — Project Codex into DSH's existing durable types/services

**Goal mapping:** Reject. `goal/change` is not a neutral view type; it is DSH's executable state machine with CAS revisions, round budgets, activation, mutation authority, and continuation scheduling. Mirroring Codex into it creates two durable authorities. Multiple app-server clients can mutate Codex without passing DSH's CAS or authority checks, and DSH can rearm/continue independently of Codex.

**Plan-mode mapping:** Conditional. The boolean value is compatible, but composing the current module also injects DSH prompt/tool/review behavior. A Codex adapter should not run that behavior while native Plan mode owns execution.

**Checklist mapping:** Acceptable as an observation. `turn/plan/updated` can map to `todo/write` because the field lifecycle is the same. The adapter should be the only producer for that Codex session; disable `todo_write` there. The DSH event becomes a durable projection of a transient provider event, not a command back to Codex.

**Final proposed plan:** No exact existing type. Do not flatten it into a checklist or plan-mode boolean.

**Assessment:** Selective reuse is valuable, but using the existing Goal/Plan controllers wholesale would duplicate semantics.

### Option 3 — Driver-neutral projections with adapter-specific execution ownership

Define small read interfaces at the Session-projection seam and keep mutation/continuation behind the owning adapter.

A neutral objective view should preserve shared facts without pretending the execution models match:

```text
owner: harness | driver
objective
lifecycle: active | paused | blocked | limited | complete
limitKind?: usage | budget
usage?: tokenBudget, tokensUsed, timeUsedSeconds, roundsStarted, maxRounds
block?: code, message
canEdit / canPause / canResume / canClear
version: adapter-owned opaque mutation token, when available
```

The `owner` is execution ownership, not display branding. For DSH-native goals, commands call `GoalService` with `GoalRef`. For Codex-native goals, commands call `thread/goal/*` and refresh from the returned/snapshot goal. A Codex projection must not claim CAS safety because the wire supplies none.

Planning needs three projections rather than one overloaded “plan” value:

1. **Collaboration mode** — default/plan and any pending local selection; execution owned by the current driver.
2. **Work checklist** — whole list of portable step/status entries; Codex may feed the existing durable `todo/write` value.
3. **Plan proposal** — final Markdown/text document associated with its thread/session and turn; rendered as a conversation item.

This creates a real seam because DSH-native and Codex-native adapters both exist. The projection modules remain deep: callers learn one small read interface, while identity translation, snapshot refresh, notification ordering, persistence, and adapter commands stay behind the adapter.

**Assessment:** Recommended final architecture. Deliver it after or together with option 1's safe initial integration.

## `AgentStatus`: current meaning and blast radius

### Current DSH contract

Core `AgentStatus` is intentionally binary:

```ts
type AgentStatus = 'idle' | 'running'
```

`idle` means no driver is active. `running` begins when wake input starts cancellable pre-step processing and lasts through drain/close/checkpoint. Disposal is not a third state. The React-loop implementation has richer private phases—idle, maintenance, running—but projects maintenance as public idle and all active turn work as running ([public definition](../../packages/core/agent/src/runtime-types.ts#L43-L50), [private phases](../../packages/core/agent-loop/src/agent.ts#L38-L47), [public getter](../../packages/core/agent-loop/src/agent.ts#L99-L110)).

This is a quiescence/scheduling contract, not a product workflow label.

### Existing consumers

Widening the union affects more than display:

- **Core and invariants:** Agent declarations/events, loop transitions, generated subsystem catalogs, type-equivalence manifests, and property tests assume binary transitions. The invariant rejects repeated values but currently need not define legal edges among several states ([agent event](../../packages/core/agent/src/runtime-types.ts#L63-L74), [invariant](../../packages/core/agent/src/invariant.ts#L14-L23)).
- **Continuation and scheduling:** goal continuation, schedule, and compaction trigger on exact `status === 'idle'`; a new non-idle string can suppress work indefinitely ([schedule trigger](../../packages/schedule/schedule/src/index.ts#L44-L65), [goal driver](../../packages/goal/goal-round-driver/src/index.ts#L96-L124)).
- **Job and subagent delivery:** callers choose wake/followup/steer and residency using exact `idle`/`running` comparisons. Some unknown values would be treated as busy; others would collapse to idle or inactive.
- **Host/Web wire:** the API proxy converts every status to `running: status === 'running'`, and Session summaries expose only a boolean. Any new value silently appears idle in the Web client ([host frame mapping](../../packages/host/apiproxy/src/api-proxy.ts#L3458-L3460), [wire frame](../../packages/host/apiproxy/src/api/events.ts#L127-L139), [Session summary](../../packages/host/apiproxy/src/api/sessions.ts#L180-L200)).
- **Client runtime/UI:** SessionManager stores and renders only that boolean; completion reminders and input state depend on the transition back to false ([host-frame consumer](../../packages/client/runtime/src/client/sessions/manager.ts#L791-L868)).
- **TypeScript SDK:** the wire type is exactly `'idle' | 'running'`; the server forwards `AgentStatus` verbatim, and `Session.run()` terminates only on exact `idle` ([SDK protocol](../../packages/sdk/protocol/src/types.ts#L58-L64), [server forwarding](../../packages/sdk/server/src/server.ts#L65-L77), [client completion loop](../../packages/sdk/client/src/api.ts#L146-L183)).
- **Python SDK:** `Session.run()` also waits for a notification whose status equals `idle`; a final Codex-specific value would hang it ([Python completion loop](../../python/sdk/src/deepseek_harness/api.py#L154-L174)).
- **Model-facing subagent status:** `list_agents` maps every live non-running Agent to `idle`, so widening the core union would silently erase the distinction anyway ([status projection](../../packages/subagent/tool-subagent-control/src/list-agents.ts#L52-L83)).

The failure mode is inconsistent: some consumers wait forever, some stop scheduling, some treat an unknown state as inactive, and some keep treating the agent as busy. A union extension cannot be made safe by updating only its type declaration.

### Codex's own separation supports a generic model

Codex does not put goals, planning, waiting, and outcomes in one status string:

- App-server `ThreadStatus` is `notLoaded`, `idle`, `systemError`, or `active` with orthogonal flags `waitingOnApproval` and `waitingOnUserInput` ([thread status type](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1621-L1642)).
- Goal status is the separate `ThreadGoalStatus` union.
- Collaboration mode is separate turn configuration.
- Multi-agent child outcome is another `AgentStatus` enum: pending initialization, running, interrupted, completed, errored, shutdown, or not found ([Codex multi-agent status](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/protocol/src/protocol.rs#L1736-L1756)).

### Recommended generic status model

Keep `AgentStatus` as the core quiescence axis:

```text
activity: idle | running
```

Add optional orthogonal projections only where a consumer exists:

```text
attention: none | approval | user-input
operation: conversation | planning | review | compaction
```

Turn completion/interruption/failure belongs to durable turn state. Subagent completion/error/shutdown belongs to the subagent run lifecycle. Goal state belongs to the objective projection. Provider-only diagnostic states such as `notLoaded` or `systemError` can remain adapter diagnostics unless DSH defines a provider-neutral recovery behavior for them.

Do not add strings such as `planning`, `waitingOnApproval`, `waitingOnUserInput`, `completed`, or `blocked` to core `AgentStatus`:

- `planning` is an operation mode while activity is running;
- waiting for approval/input is active work with an attention requirement, not quiescence;
- `completed` is a turn/subagent outcome, while a resident DSH Agent can run later turns;
- `blocked` is objective state, not whole-Agent activity.

If DSH needs richer Web rendering, add a separate whole-value `agent/activity` projection or host frame with these axes. Preserve `host/session-status.running` and SDK `session.status` as the binary completion barrier until a deliberately versioned protocol replaces them.

## Recommended integration sequence

1. **Resident Codex driver:** map Codex whole-turn activity to DSH `running`/`idle`; persist normal DSH turn/message/tool events, but do not widen `AgentStatus`.
2. **Native ownership:** for Codex-backed persistent sessions, enable native Codex goals and planning and disable DSH goal-round/tool-goal, plan prompt/review controller, and todo mutation tool.
3. **Goal projection:** add a driver-neutral objective read model with explicit owner/capabilities. Seed Codex state from `thread/goal/get`, apply complete `updated`/`cleared` snapshots, and route commands back to Codex. Do not emit `goal/change` for native goals.
4. **Checklist projection:** translate each Codex `turn/plan/updated` full list into a durable DSH checklist snapshot—prefer the existing `todo/write` value if the adapter is its only producer for that session. Preserve turn association through event position/turn fields.
5. **Collaboration mode:** separate DSH's plan projection/value from its DSH-native prompt, command, and review execution. Let the Codex adapter own native mode selection while the generic projection drives the existing Plan chip.
6. **Proposed-plan item:** persist completed `ThreadItem::Plan` as its own DSH conversation event/node. Stream deltas only for live rendering; replace them with the authoritative completed item.
7. **Attention projection:** map Codex active flags to an orthogonal approval/user-input attention view. Do not change scheduler or SDK completion semantics.
8. **Multi-agent scope:** keep goals/checklists/proposals scoped to the child thread/session that emitted them. Aggregate into parent views only through an explicit orchestration projection, not by silently rewriting child activity as parent state.

## Final decision

Option 1 is the correct safety posture for the first Codex-backed persistent Agent: disable DSH execution ownership and render native activity. Option 3 is the correct architecture: a small driver-neutral projection interface with adapter-specific execution ownership. Option 2 is appropriate only for exact read-value matches—principally Codex `update_plan` to DSH `todo/write`, and eventually a split collaboration-mode projection—not for DSH `GoalService` or the current combined Plan controller.

Keep `AgentStatus` binary. Rich Codex states should become orthogonal generic activity, attention, collaboration, objective, turn-outcome, and subagent-outcome projections. That preserves the core scheduling/SDK completion contract and avoids embedding one provider's workflow vocabulary into every Agent consumer.
