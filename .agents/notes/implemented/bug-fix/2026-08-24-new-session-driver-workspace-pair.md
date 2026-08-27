# Agent Note: New Session Driver and Workspace choices materialize one immutable Session

Status: implemented

English | [中文](2026-08-24-new-session-driver-workspace-pair.zh.md)

## Problem

An Agent Driver selector mounted in the session-scoped composer can appear after a conversation has started even though `SessionHeader.driverId` is immutable. Treating that control as a switch requires replacing the current blank Session or forking a populated Session behind a setting-like interaction. The resulting Session identity change is not evident from the control.

Driver and Workspace selection also need one materialization decision. Creating a replacement blank Session from cwd alone drops Workspace membership, while a later Workspace connection that does not carry `driverId` reuses or creates the Host-default Driver. The two selection orders therefore disagree. A native `<select>` adds a presentation failure because its operating-system popup does not reliably inherit the Web dark theme.

## Decision

The [immutable Driver binding](../architecture/2026-08-23-session-bound-agent-driver-registry.md) remains a creation fact. ui-conversation declares the root-scoped `conversation.hero.agentDriver` slot beside `conversation.hero.workspace`; `ConversationRoot` renders both only in its no-session or blank-session Hero and supplies `{ selectedDriverId?, selectDriver }` to the Driver contribution.

`ConversationRoot` stages an unmaterialized Driver choice locally. A Workspace pick calls `selectWorkspace(workspaceId, { driverId })`; a Driver pick with an existing Workspace calls the same operation for that Workspace. Once the Host publishes the resulting blank Session, its summary `driverId` becomes the displayed authority. The active composer has no Driver slot, and the creation control never calls `sessions.fork()`.

`WorkspaceRuntime.connectWorkspace(workspaceId, options?)` owns the combined decision. When `options.driverId` is present, blank reuse requires Workspace membership, canonical cwd equality, and the same Driver binding. A miss calls `session.create({ workspaceId, driverId })`, while in-flight attempts coalesce by the Workspace and Driver pair. The existing synchronous-addressability guarantee still lets ui-conversation move a draft before opening the returned Session ([New Session ownership](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md)).

The external Codex Driver contribution renders the shared `Menu` primitive from `ui-primitives`. The trigger and menu consume theme tokens, and the control carries only the selected Driver name and chevron; no unexplained abbreviation or fork-mode copy is present.

## Verification

Client runtime and conversation specs pin both selection orders, Driver-aware reuse and creation, pair-keyed coalescing, and the root-scoped Hero slot. The external package build keeps `ui-primitives` as a shared Client module and its packed browser artifact contains the Hero registration without the native selector, abbreviation, or fork copy. The default Web composition has no third-party Driver selector, so the product-visible proof is an installed-plugin browser run rather than a keyless default-composition snapshot.

## Alternatives considered

**Keep a session-scoped Driver switch and fork populated Sessions.** This exposes an identity-changing operation as a setting, leaves the control visible after the binding is fixed, and can fork work without an explicit Session action.

**Let each external Driver plugin create or select Sessions directly.** That duplicates Workspace membership, blank reuse, draft transfer, and current-Session orchestration outside their owning runtime and conversation packages.

**Retain the native select and add dark option colors.** Native popup rendering is platform-owned and does not consistently honor option styling. The shared Menu already owns themed browser rendering, focus, selection, and portal placement.

## Consequences

Driver-first and Workspace-first selection produce the same Session binding and membership, and active conversations cannot imply that their immutable Driver changed. Selecting another Driver for an existing blank Session can leave the prior blank Session hidden in the list mirror; this matches existing Workspace-switch residue and allows later pair-specific reuse. Driver discovery and presentation remain external-plugin responsibilities, while ui-conversation and WorkspaceRuntime own materialization.
