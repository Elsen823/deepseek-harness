# Agent Note: Global agent factory waterfall

Status: implemented

English | [中文](2026-08-30-agent-factory-waterfall.zh.md)

## Problem

`AgentRegistry` exposed one factory slot implemented by `dsh-agent-loop`. That seam kept consumers independent of the loop package, but an external main-agent driver could participate only by replacing the default factory for the whole process or by maintaining a fork inside the loop. Selecting an alternate implementation through a new `driverId` in every Session header would spread provider policy through Session creation, persistence, SDKs, UI, examples, and migrations even though most deployments still need one default loop.

A deployment needs to intercept selected create and resume operations, retain the original caller-owned Cordis context, and return the same lifecycle-owning `AgentHandle` abstraction without changing existing callers.

## Decision

`AgentRegistry.create()` and `resume()` route a discriminated `AgentFactoryRequest` through the global asynchronous `agent/factory` waterfall. The request preserves the operation kind, the original options object, and the caller-traced `ownerCtx`. A listener may return an alternate `AgentHandle` and thereby own the complete lifecycle, or call `next()` to compose with later listeners. The terminal continuation invokes the existing sole registered `AgentFactory` with the same owner context and traceable receiver.

The default factory remains a single slot. A request handled by an interceptor does not require that slot to exist; a request that reaches the terminal continuation without a registered factory fails with the existing load-an-agent-loop diagnostic. Factory providers and alternate listeners both return the public handle, so cancellation, ownership, teardown, and caller behavior do not gain a second abstraction.

Selection policy belongs to the intercepting plugin. Core does not add a driver registry, a required Session header discriminator, fallback by persisted string, or knowledge of any external driver. A driver that needs durable resume ownership records it through plugin-owned Session events and registers those event types independently.

## Alternatives considered

**Add a `driverId` to `SessionHeader` and a registry keyed by it.** Rejected because it turns one deployment choice into a permanent core persistence and wire field, forces every creation path to select a driver, and privileges drivers over other construction interceptors before multiple first-party drivers exist.

**Let an external plugin replace the sole factory.** Rejected because the shipped loop still owns ordinary Sessions, and two providers cannot safely race to set one slot or unload independently.

**Add extension hooks inside `dsh-agent-loop`.** Rejected because alternate construction would remain coupled to the concrete driver package and would violate the rule that new behavior uses documented extension points rather than loop changes.

**Register multiple factories with priorities.** Rejected because it combines selection policy, provider identity, and fallback ordering into core. Cordis waterfall order already supplies explicit composition, and each listener can decide whether to delegate.

## Consequences

An external main driver can handle only the Sessions it owns while the normal loop remains the default for every other request. Existing callers, handles, and Session headers are unchanged. The interceptor receives a powerful lifecycle seam: if it short-circuits, it must reproduce creation/resume validation, publication, rollback, initiator attribution, and teardown guarantees required by `AgentHandle` consumers.

Registry tests pin create and resume delegation with the original options and caller fiber, short-circuiting without a default factory, downstream fallback, and the unchanged single-factory lifecycle. The generated Cordis catalog publishes the request signature and waterfall mode.
