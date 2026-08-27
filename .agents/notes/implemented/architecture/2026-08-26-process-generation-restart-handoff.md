# Agent Note: Process-generation restart handoff for resident Agent Sessions

Status: implemented

English | [中文](2026-08-26-process-generation-restart-handoff.zh.md)

## Problem

An Agent, its Cordis scope, and its native Driver connection belong to one DSH process, while an opted-in resident Session must retain logical Session and native-Thread continuity when the Web process is replaced. Ordinary provider unload, explicit Release Agent, and process stop intentionally dispose those resources and emit their lifecycle edges, so treating every shutdown signal as a restart either tears down resident work or leaves ownership ambiguous.

## Decision

The generic Agent registry exposes one explicit `restartHandoff()` operation in addition to ordinary disposal. It writes a versioned owner-only sidecar intent in the `requested` phase, atomically publishes resident Session records in the `committed` phase, and marks a failed request `rejected`; a restart is never inferred from `SIGTERM`, and only a caller that enters this operation can obtain handoff semantics.

### Sidecar ownership and validation

`RestartHandoffStore` stores generation, lease expiry, explicit `resident: true`, Session and Driver ids, the flushed event count and digest, and Driver-owned lossless JSON state outside the model-visible Session log. It uses an owner-only directory, exclusive temporary files, atomic replacement, a serialized generation lock with dead-lock recovery, and compare-and-replace claims; an unexpired generation or Session claim rejects a second owner, while an expired claim remains recoverable without changing the record identity.

### Bounded quiescent publication

`AgentRegistry.restartHandoff()` closes new lifecycle and API admissions, waits for already-admitted operations, waits for every opted-in Agent to become idle, flushes its Session exactly once, verifies the Session prefix did not change, and asks the generic Driver handoff hook for state. All fallible Driver checks run before publication; after the records publish together the registry enters `committed`, fences every old entry, and invokes synchronous commits that are required to be infallible local state flips. A timeout, cancellation, missing hook, or changed prefix rejects the intent and restores the old generation to active service without calling ordinary Agent or Driver disposal; a violating post-publication commit throw leaves the registry committed and never reopens the old generation.

### Reattachment and request fencing

The next assembled generation lists only committed resident records, claims each exact record, validates Session id, immutable Driver id, event count, digest, and Driver-specific state, then resumes through the normal unpublished preparation transaction before transferring the exact new handle to its API proxy and completing the claim. A Driver can reattach the same native Thread when its compatibility proof passes or use its existing explicit portable reconstruction policy when native state is missing or incompatible; a claim is released for retry when preparation or ownership transfer fails, while a completion race after successful transfer keeps the replacement and claim fenced rather than disposing a handle already owned by the API generation. Requests admitted by the old API generation that cross the barrier receive a retryable generation response, and stale handles cannot release the replacement Agent.

### No-teardown invariant

Successful handoff does not invoke `PreparedAgentDriver.dispose()`, emit `agent/disposed` or `session/disposed`, append Driver activation `stopping` or `stopped`, or send native `thread/unsubscribe`. The Codex Driver's handoff commit fences its Agent after idle and lets process-local handles disappear with the old process; explicit Release Agent, provider unload, ordinary stop, and handoff rejection continue to use the existing disposal and persistence-retirement behavior.

## Alternatives considered

**Infer handoff from `SIGTERM`.** Rejected because a supervisor stop and an explicit restart have different durability and teardown obligations; an undifferentiated signal cannot prove intent or safely preserve resident ownership.

**Skip `fiber.dispose()` for resident Agents.** Rejected because the old registry, persistence owner, API handle map, and native connection would remain coupled to a process that is exiting, with no bounded barrier or duplicate-generation protection.

**Put residency in the Session log or infer it from `driverId`.** Rejected because process ownership is not model-visible state and persisted Driver history does not opt a Session into revival; the sidecar keeps the Session format unchanged and requires an explicit marker.

**Move the Agent registry into a resident supervisor.** Rejected for this foundation because it is the only design that preserves the same JavaScript Agent object, but it adds an authenticated process boundary, IPC lifecycle, startup ordering, and a second failure-recovery protocol. It remains the appropriate architecture if uninterrupted in-flight execution or object identity becomes a requirement.

## Consequences

Logical continuity is defined as the same durable Session id and, when compatible, the same native Thread id with a new process-local Agent and API handle. Resident opt-in is explicit at Session creation or resume, deployment bounds are validated at AgentRegistry load, and sidecar generations and leases are independently versioned from `SESSION_FORMAT_VERSION`.

The handoff barrier preserves accepted persistence once and leaves the old generation serving on refusal, but it cannot preserve an in-flight browser request or a JavaScript object across process exit. Clients reconnect by Session id and retry generation-fenced requests; missing or incompatible native state remains visible through the Driver's reconstruction status and policy.

## Verification

Core tests cover sidecar atomic intent, dead-lock recovery, leases, exact claims, bounded quiescence, flush-once behavior, ordinary disposal, post-publication commit failure, completion-race retention, failed adoption cleanup, and stale API requests. The external Driver tests cover no-unsubscribe/no-teardown handoff, same-Thread validation, native reconstruction, and ordinary release; the Loader test boots two real compositions through the shipped `apply` entry against shared temporary persistence and a fake native Host, adopts the exact resident Session in the second generation, and verifies a new Agent handle without duplicate or teardown events. A keyless assembled Web snapshot pins Session/native reconnect identities, while live Web/Host restart, browser, model, Agent-release, rollback, and durable-log verification remain separately authorized operations under the [testing policy](../../../../docs/testing.md).
