# Agent Note: Driver-neutral Session runtime and work-state projections

Status: implemented

English | [中文](2026-08-23-driver-neutral-session-runtime-and-work-state.zh.md)

## Problem

`AgentStatus = 'idle' | 'running'` correctly answers whether one published Agent is quiescent, but an Agent Driver also has state before publication and while waiting for human attention. Durable Sessions can be cold or unavailable without a live Agent, and approval and user-input requests can coexist with running work. Provider-native objectives, checklists, and completed plan documents also do not share DSH Goal or Plan Mode identity and mutation semantics.

Overloading `AgentStatus`, `goal/change`, or `plan/mode` would make existing consumers interpret unrelated state and would invent common execution semantics that the providers do not have. A second durable projection framework would duplicate [Session projections and command lifecycle logging](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) and its shipped [host-state/client-view split](2026-08-19-session-projection-state-and-client-views.md).

## Decision

### Binary Agent activity remains unchanged

`AgentStatus` remains exactly `idle | running` and remains the completion and quiescence signal for a published Agent. Waiting for approval or user input does not make running work idle. A durable Session without a live Agent has no synthetic Agent status and no placeholder Agent.

### Process-local Session runtime status

`SessionRuntimeStatus` is a process-local current-value service, not a Session-log projection. It reports the immutable Session and Driver ids, availability (`cold`, `activating`, `available`, or `unavailable`), optional binary activity while an Agent is available, current generic operation, Driver-owned diagnostic detail, and independent pending approval and user-input counts.

Driver activation and attention contributions are effect-scoped. Independent contributors are counted rather than collapsed into one boolean, so approvals and user-input requests can coexist. Runtime revisions order current Host observations but are not replayed after restart; replaying connection attempts or stale attention would misrepresent the current process.

### Static Agent Driver events

Core statically declares the durable outer event family: `agent-driver/activation`, `agent-driver/model-request`, `agent-driver/model-attempt`, `agent-driver/activity`, `agent-driver/objective`, `agent-driver/proposed-plan`, and `agent-driver/checkpoint`. Driver-owned nested discriminants remain open and carry lossless JSON, while the known outer purposes preserve generic replay, fallback rendering, and compatibility checks when the owning Driver is absent.

Unknown required outer events fail closed. A Driver's model-visible request event records the exact messages, images, tools, instructions, resolved model call configuration, and captured retry policy required for reconstruction. Native commands, file changes, diffs, reasoning summaries, and status remain Driver activity rather than synthetic DSH `tool/*` events unless they actually ran through `ctx.tools`.

### Portable work-state projections

`agent-driver/objective` carries a Driver-neutral whole Objective snapshot with explicit execution owner, text, normalized phase, optional budget, attention or stop reason, and opaque routing data. It does not manufacture DSH Goal ids, revisions, CAS, Round budgets, or continuation rules. The DSH objective adapter derives the same portable view from the authoritative DSH Goal domain without duplicating `goal/change`.

The portable Checklist remains the existing whole-list `todo/write` event and `TodoItem` vocabulary. Projection production is separated from the model-facing `todo_write` Consumer, so a native Driver can publish normalized `pending`, `in_progress`, and `completed` items while retaining sole mutation ownership.

`agent-driver/proposed-plan` carries a durable completed plan document with its own identity and lifecycle. Proposed Plan is distinct from Checklist progress and from DSH Plan Mode. No generic native collaboration-mode control or native collaboration-mode Web UI is part of this decision.

### Host, SDK, and Web projection

Existing Session carriers expose the immutable Driver id, current runtime status, and registered durable projection values. TypeScript and Python SDK completion remains based on binary `session.status`; runtime availability is a separate value, and an unavailable Session fails an owned wait rather than being treated as idle.

The Web supports durable Sessions without a live Agent and renders Driver selection, runtime availability and attention, Driver activity, Objective, Checklist, and Proposed Plan through Session-scoped stores and registered conversation nodes.

## Alternatives considered

**Add provider state to `AgentStatus`.** Activation can precede Agent publication, attention can coexist with running, and Objective phase is not whole-Agent activity. One union cannot preserve those independent meanings.

**Persist every runtime transition.** Replaying an old connecting or waiting value would lie about the current Host. Only durable provenance, requests, attempts, activity, work state, and checkpoints belong in the Session log.

**Use `goal/change` for every Driver.** Native objective APIs do not necessarily expose DSH identity, revision, Round admission, or continuation semantics. Fabricating those fields creates unsafe concurrency expectations.

**Mount DSH Goal, plan, and todo mutation beside native execution.** Two owners would race to mutate similarly named values with different semantics. Each Session has one execution owner for each control-capable domain.

**Treat a completed plan as Checklist text or Plan Mode.** A document with review lifecycle is neither a task-status list nor a collaboration-mode selection.

**Create another Driver projection framework.** The existing Session projection registry already owns durable folds and client views; only transient runtime status needs a separate process-local service.

## Consequences

Generic consumers can distinguish durability, availability, activity, attention, and portable work state without learning a Driver protocol. Driver unload can make execution unavailable but does not make same-version known outer events unreadable. Open nested Driver data requires bounded payloads and fallback presentation, while scheduling and completion ignore it.

The portable projections deliberately expose less control than provider-native state. Identity, mutation, accounting, concurrency, and continuation remain with the selected execution owner. Collaboration-mode integration requires a separate shipped control and UI decision rather than being implied by Proposed Plan support.

## Verification

Core and package tests pin unchanged binary `AgentStatus`, cold/activating/available/unavailable runtime values, independent attention counts, effect disposal, immutable Driver matching, static event validation, unknown-required-event failure, exact model-request reconstruction, Objective ownership, portable Checklist folding, Proposed Plan projection, Host carriers, SDK runtime observation, and Web runtime/activity/work-state rendering.
