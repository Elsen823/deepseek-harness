# Agent Note: next-step steering survives the idle handoff

Status: implemented

English | [中文](2026-08-25-next-step-steering-idle-handoff.zh.md)

## Problem

An AgentLoop could finish a Turn after checking an empty `next-step` inbox while a queued microtask still had permission to submit steering. The message then arrived before the running phase published `idle`, and the live phase did not retain a wake request, leaving the durable message pending until an unrelated later wake.

## Decision

`ReactLoopAgent` marks the running phase as closing immediately before its final post-`turn/end` inbox check. A wake requested during that closing window is latched and replayed after the phase publishes `idle`; wakes submitted during maintenance or after an abort retain the existing replay behavior, while disposal never starts another Turn. Non-waking `inject()` messages keep their parked semantics.

## Alternatives considered

**Wake for every pending inbox message at phase teardown.** This would also run parked `inject()` context that was intentionally submitted to an idle Agent without a wake request. The wake marker remains tied to a caller-requested wake instead.

**Rely on `agent/turn-stopping`.** That extension point is awaited before the final check, but it cannot observe a message submitted by a later microtask during the handoff itself. The phase-owned closing marker covers that ordering gap without changing the extension API.

## Consequences

Steering and follow-up messages admitted across the final inbox check receive one automatic continuation and are not stranded. The loop retains the existing distinction between waking Chat input and non-waking injected context, and the additional phase bit remains process-local rather than changing the Session event format.

## Verification

The contract-regression test schedules `steer()` from a microtask attached to `turn/end`, then asserts the second request consumes it and the `next-step` inbox is empty. The AgentLoop loop, cancellation, coverage-edge, and contract-regression suites pass.
