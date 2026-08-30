# Agent Note: Adapter-owned request service tiers

Status: implemented

English | [中文](2026-08-30-adapter-owned-service-tiers.zh.md)

## Problem

A provider may offer request scheduling classes with different latency, quota, and cost behavior. The chosen class affects the exact provider request and must survive reconstruction, but its identifiers and wire support belong to the selected adapter. A product-level Fast Mode is a deployment choice: putting its toggle event and tier names in core would make every composition carry one product's policy.

Out-of-tree request producers also need to apply a captured tier without forking the agent loop or hiding it in an untyped native payload. Unsupported routes must fail before provider I/O; silently dropping a paid scheduling choice would record and display behavior that the provider did not receive.

## Decision

`ServiceTierId` is an opaque adapter-owned brand carried by `GenerateOptions.serviceTier` and `LlmCallConfig.serviceTier`. Core compares and freezes the value, includes it in `request/header`, and passes it to the selected adapter; core defines no tier names, defaults, or global selection event. The [LLM subsystem reference](../../../../docs/subsystems/llm-streaming.md) owns the request types.

Adapters validate support at their final request boundary. `dsh-llm-pi-ai` maps `priority` to the OpenAI-compatible `service_tier` field only for `openai-responses` and `openai-codex-responses`. Other pi-ai protocols and the direct DeepSeek chat-completions adapter reject an explicit tier with `UNSUPPORTED_OPTION` before network I/O.

A deployment plugin owns Fast Mode intent as a required external Session event, registers its event type while active, folds the current selection, and contributes the effective tier through the request producer's waterfall. The Codex integration uses `fast-mode/selected: { enabled: boolean }` and `codex/request-options`; explicit Standard removes an inherited tier. Its command exists only in Agent scopes carrying `codex/binding`, so ordinary Sessions do not acquire a control their request path cannot honor. The event is required rather than ignorable because omitting it can reconstruct a different provider request.

## Alternatives considered

**Define `llm/service-tier` and Fast/Standard values in core.** This gives one event name broad visibility but makes deployment UI policy part of the provider-neutral Session vocabulary and forces readers without that product feature to understand it.

**Keep the tier only in a native Driver payload.** This avoids a core field but prevents `request/header` equality and reconstruction from representing the effective provider request, and it gives non-Driver adapters no typed input.

**Use a generic provider-options dictionary.** This accepts future fields without core changes but removes compile-time ownership, lets misspellings cross package boundaries, and cannot state which values affect request-header equality.

**Ignore unsupported tiers.** This keeps more routes running but falsely reports the selected scheduling behavior and can change quota or cost expectations without a failure.

## Verification

LLM call-config tests pin equality, freezing, and prepared-call propagation of the tier. Session seed tests reject malformed durable tier values, and loop reconstruction tests recover the dispatched tier from `request/header`. The pi-ai wire test observes `service_tier: "priority"` on a real Responses payload, while pi-ai value, protocol, and direct DeepSeek tests prove unsupported tiers fail before network I/O. The external Fast Mode lifecycle tests pin event registration, scoped command ownership, explicit Standard clearing, projection replay, and `codex/request-options` propagation into the recorded Codex model request.

## Consequences

Provider-neutral request state gains one opaque field, while each adapter retains authority over accepted values and wire mapping. A deployment that persists Fast Mode must load its plugin to read those Sessions, which prevents a missing policy owner from silently changing future requests. Plugin authors pay for their own event, projection, command, and migration, but can add scheduling choices without changing the loop or extending core with product-specific durability.
