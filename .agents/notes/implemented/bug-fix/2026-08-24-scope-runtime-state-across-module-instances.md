# Agent Note: Scope runtime state across module instances

Status: implemented

English | [中文](2026-08-24-scope-runtime-state-across-module-instances.zh.md)

## Problem

The supported [tsx source launch](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md) resolves workspace imports to TypeScript sources, while an installed external Agent Driver executes built JavaScript and resolves peer dependencies through package exports. One JavaScript realm can therefore evaluate `packages/core/scope/src/index.ts` for the Host and `packages/core/scope/lib/index.js` for the Driver.

A scope identity consists of more than its context tag. The parent relation controls preset inheritance, and carrier marks control scoped event admission and invariant checks. If each module instance owns a private tag symbol and private `WeakMap` objects, a Driver can create a valid scoped Agent Context that the Host reads as unscoped. [`AgentPresets.mount()`](../architecture/2026-08-08-per-preset-standing-mounts.md) then rejects setup before publication, and Agent creation rolls its unpublished Session back. Sharing only the tag would leave parent links and carrier recognition split.

## Decision

Every compatible `dsh-scope` copy evaluated in one JavaScript realm obtains one internal `ScopeRuntimeState` from the `globalThis` slot keyed by `Symbol.for('@deepseek-ai/dsh-scope/runtime')`. The first copy creates revision `1` with one context-tag symbol, carrier-key map, and scope-parent map. Later copies reuse the complete state. A copy that finds another revision throws during module evaluation instead of operating with partially shared identity.

The shared slot is an implementation detail: public function signatures and types, configuration, event names and payloads, and durable data do not change. Cross-copy lookup and routing are interoperable. Workers, processes, and other realms retain independent state. The package continues to route trusted same-process plugins rather than enforce authority, as defined by the [Agent scope decision](../architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

This decision extends the [scope runtime design](../architecture/2026-07-12-agent-scope-runtime-design.md) with module-instance interoperability. It does not change the source-plane resolution rules in the [TypeScript program decision](../process/2026-07-22-tsconfig-solution-root-two-aggregates.md), nor the preset parent-chain semantics that consume the shared relation.

## Verification

- [`module-instances.spec.ts`](../../../../packages/core/scope/tests/module-instances.spec.ts) evaluates two source module URLs, reads a tag created by the first instance in the second, reads parent and rebind state created by the second in the first, recognizes carriers in both directions, proves disposal awaits asynchronous cleanup, and exercises incompatible-revision failure.
- [`api-proxy-agent-driver-preset.spec.ts`](../../../../packages/host/apiproxy/tests/api-proxy-agent-driver-preset.spec.ts) creates a Session through the public API with a non-default Driver using a second scope module instance, observes preset composition and Agent publication, and retains the negative rollback case for an unscoped Driver.
- Deployment evidence for external Driver archive SHA-256 `68cc7c6906872b090bcb1720a5cc8eafb6a6a784053d9f58fd07c783adb77b47` comes from a process smoke that loads its installed entry and `CodexAgent` beside the source Host, verifies that the Driver resolves `dsh-scope/lib/index.js`, and observes successful preset composition through `session.create` without contacting Codex transport. The external package is outside this repository, so this exact artifact topology remains deployment evidence rather than a checked-in regression; the two repository tests above pin the shared-state and call-site behavior.

## Alternatives considered

**Canonicalize peer imports in the Loader.** A Loader-level singleton policy would have to own source and artifact resolution for every workspace peer, not only `dsh-scope`. It also competes with the supported tsx source resolver. That repository-wide module-resolution decision is unnecessary when the identity-owning package can make compatible copies interoperable.

**Share only the context-tag symbol through `Symbol.for()`.** This repairs `scopeOf()` but leaves `bindScopeParent()`, `scopeChainOf()`, `isScopeCarrier()`, and `carrierKeyOf()` reading module-private maps. Preset inheritance and event-routing invariants would still depend on which copy receives the value.

**Remove the unscoped-context check from preset composition.** This would publish an Agent without the prompt, tools, listeners, and presentation registrations selected by its preset. The check identifies incomplete setup and remains a required rollback guard.

**Require a built Host or hard-code the source package URL in external Drivers.** A built-only launch hides the defect by making URLs coincide and abandons the supported source launcher. A repository-specific absolute import makes external packages non-portable. Neither establishes interoperability for other valid module graphs.

## Consequences

Source Hosts and built external Drivers can exchange scoped Contexts, parent relations, and event carriers within one realm. Future changes to the shared state's meaning require an explicit revision change; incompatible participating copies fail at module evaluation rather than silently disagree.

The cost is one well-known realm slot and a hard failure for incompatible revisions. The slot does not cross a worker or process boundary and does not strengthen or weaken plugin authority. No Session format, wire field, model-visible input, configuration key, or public API changes.
