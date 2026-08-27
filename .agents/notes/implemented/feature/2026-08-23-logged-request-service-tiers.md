# Agent Note: Logged request service tiers

Status: implemented

English | [中文](2026-08-23-logged-request-service-tiers.zh.md)

## Problem

Codex Fast mode is not a model switch or a reasoning-effort shortcut. It selects the provider request service tier `priority`, while the standard choice removes that override. Harness had no call-config field for this decision, so an installed `/fast` plugin could neither pass the tier through `agent/request` nor make the effective wire request reconstructable from `request/header`. Rewriting the frozen request in `llm/stream` would make the provider request disagree with the durable header.

The pi-ai dependency already accepts service tiers in its OpenAI Responses implementations, but its protocol-neutral `streamSimple()` options omit that field. The direct DeepSeek chat-completions adapter has no service-tier wire field at all. A shared request value therefore also needs explicit adapter mapping or refusal rather than silent omission.

## Decision

`dsh-llm` owns the opaque branded `ServiceTierId`. `LlmCallConfig.serviceTier` and `GenerateOptions.serviceTier` carry the selected adapter-owned id, and `callConfigEquals()` compares it. Agent request waterfalls can return a replacement config with a tier; Agent Loop then prepares the exact adapter call, writes the tier in the full `request/header`, and builds the frozen request from that header under the existing [reconstructable-request rule](../../implemented/architecture/2026-07-05-reconstructable-requests.md).

`@deepseek-ai/dsh-llm-pi-ai` accepts an explicit tier only for `openai-responses` and `openai-codex-responses`. Its common stream path uses pi-ai's `onPayload` hook to add the provider field `service_tier` after pi-ai constructs the typed request body. Other pi-ai protocols reject the option with `UNSUPPORTED_OPTION` before credential or provider I/O. `@deepseek-ai/dsh-llm-deepseek` rejects the same option before provider I/O because DeepSeek chat completions do not define it.

The installed `@dsh-external/dsh-fast-mode` plugin is the first producer. Core session vocabulary includes the whole-value `llm/service-tier` event so persistence readers recognize an installed plugin's durable choice: `ServiceTierId('priority')` means Fast and `null` means the provider standard. The plugin applies that choice after downstream `agent/request` routing. Its browser decoration presents Fast and Standard choices but submits `/fast on` or `/fast off` through the host command, so the durable event remains the only state writer.

## Alternatives considered

- **Map Fast mode to reasoning effort `off`.** Rejected because Codex Fast mode changes request scheduling through `service_tier: "priority"`; it does not disable reasoning, choose another model, or change the provider route.
- **Rewrite the request in `llm/stream`.** Rejected because loop-built `GenerateOptions` are already logged and frozen there. A late rewrite would violate request reconstruction and prepared-call equality.
- **Add a generic untyped provider-options bag.** Rejected for this producer because the loop could not compare or document the relevant field without defining its durable equality semantics. The focused opaque id keeps one small interface and lets each adapter map or reject it explicitly.
- **Send a custom HTTP header.** Rejected because OpenAI Responses defines a JSON body field, and gateways use that field for service-tier accounting and routing.

## Consequences

Per-session Fast mode changes are durable, survive resume and fork, and produce a new `request/header` whenever the effective tier changes. Provider adapters cannot silently ignore the field: supported Responses protocols send it, and unsupported protocols fail before network I/O. The core vocabulary intentionally does not advertise which tiers a model supports; the current producer selects the evidenced `priority` id, while provider capability discovery remains deferred until a second consumer needs a selectable tier catalog.
