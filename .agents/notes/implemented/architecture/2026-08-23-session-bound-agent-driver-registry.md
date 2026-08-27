# Agent Note: Session-bound Agent Driver registry

Status: implemented

English | [中文](2026-08-23-session-bound-agent-driver-registry.zh.md)

## Problem

`ctx.agents` previously delegated every create and resume through one composition-wide implementation. That could replace the default agent loop for a deployment, but it could not keep multiple first-class execution implementations available as durable per-Session choices. A resumed Session also lacked a durable field proving which implementation owned its history.

The existing ownership decisions remain load-bearing. `AgentHandle` disposal and ordered Agent/Session publication are owned by [Agent lifecycle and ownership contracts](2026-06-18-agent-lifecycle-and-ownership-contracts.md), while binary `AgentStatus` is owned by [the observable agent-loop state machine](../simplification/2026-07-24-agent-loop-observable-state-machine.md). Driver selection extends those decisions rather than replacing them.

## Decision

### Immutable Driver binding

Every `SessionHeader` contains a required branded `driverId`. The value is immutable for the Session and is carried by persistence, query, Host, Web, and both SDK projections. Fresh creation uses the explicitly selected Driver or the registry default; resume selects only the Driver recorded in the persisted header. A missing registration fails rather than inferring another Driver.

The built-in Driver id is `dsh`, backed by the existing DSH agent loop. Driver identity remains independent of the [per-Session Agent preset](2026-08-03-per-session-agent-presets.md): the Driver selects the execution implementation, while the preset selects scoped composition for that Session. Changing execution implementation requires a distinct Session or fork and does not rewrite the source binding.

The Web creation control appears only in the New Session Hero. It submits the selected Driver with the selected Workspace when connecting or creating the blank Session; active-session controls cannot change the binding or initiate an implicit fork. Programmatic forking remains a separate explicit Session operation ([decision](../bug-fix/2026-08-24-new-session-driver-workspace-pair.md)).

### Effect-scoped named generations

`AgentRegistry` stores named `AgentDriver` registrations by `AgentDriverId`. Each registration is a reversible Cordis effect and one exact provider generation. Disposing that generation aborts unpublished preparation, stops and drains every live Agent it created, and waits for lifecycle wrappers before the registration disappears. Another Driver can remain registered and active in the same composition.

Drivers publish immutable discovery metadata and implement one generic `prepare(session, options, signal)` operation. Preparation returns an unpublished Agent plus narrow `start` and `dispose` hooks; product-specific lifecycle methods do not enter the registry API.

Core delivers source-tagged `UserMessage` content without interpreting provider-native command, skill, mention, or prompt semantics. Each Driver owns any native structured-input expansion behind its Agent implementation.

### Unpublished preparation and publication transaction

The registry owns the generic create/resume transaction. It prepares or restores the Session, selects the bound Driver, awaits Driver preparation and scoped setup, runs the synchronous setup commit, and only then publishes the Session and Agent and starts execution. Failure, cancellation, owner disposal, or Driver unload rolls unpublished work back without exposing either registry entry.

The registry remains the sole owner of duplicate-live-Session prevention, publication order, registry detach, and final Session flush ordering. Each Driver owns its private connection, execution, cancellation, quiescence, and prepared-scope cleanup behind the returned hooks.

### Runtime and work-state dependency

Driver binding does not redefine whole-Agent quiescence or create a shared provider-native Goal state machine. [Driver-neutral Session runtime and work-state projections](2026-08-23-driver-neutral-session-runtime-and-work-state.md) owns process-local availability and attention plus portable durable projections keyed by this immutable Driver identity.

Process replacement uses a separate generic [process-generation restart handoff](2026-08-26-process-generation-restart-handoff.md). A Driver may provide `PreparedAgentDriver.handoff()` for bounded quiescence and non-disposing adoption; ordinary provider unload and `AgentHandle.dispose()` remain the only paths that invoke `dispose()` and emit teardown lifecycle edges.

## Alternatives considered

**One Agent factory per composition.** This makes an alternate implementation a deployment-wide replacement and cannot preserve a per-Session execution choice across resume.

**Branch inside `dsh-agent-loop`.** That would make the default loop own unrelated execution engines, native protocols, and external process lifecycles. Named Drivers keep the built-in loop independent.

**Encode Driver choice as an Agent preset.** A preset chooses scoped composition, not immutable execution ownership or native resume compatibility. The two header fields have different meanings and lifecycles.

**Reuse the subagent registry.** A subagent provider owns a delegated child task or conversation, not the parent Session's execution, Web conversation, or resume binding.

## Consequences

One composition can host multiple Driver generations while every Session has exactly one durable execution owner. The required header field intentionally makes old or partial producers fail until they write a valid Driver id. Provider unload is a lifecycle event: affected live Agents drain and detach instead of silently moving to another Driver.

Driver authors receive a smaller public API but must satisfy the registry's prepare, cancellation, rollback, quiescence, and disposal obligations. Product-specific control remains in Driver-owned services and projections rather than accumulating optional methods on `AgentDriver`.

## Verification

Core lifecycle tests cover named registration, duplicate ids, default `dsh` selection, persisted-only resume selection, unpublished rollback, same-id races, owner and provider unload, cancellation, quiescent disposal, publication order, and Session flush ordering. Persistence, query, Host, TypeScript SDK, Python SDK, and Web tests pin the required immutable `driverId` across their carriers.
