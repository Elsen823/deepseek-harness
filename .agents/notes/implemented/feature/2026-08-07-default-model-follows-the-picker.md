# Agent Note: the default model follows the picker

Status: implemented

English | [中文](2026-08-07-default-model-follows-the-picker.zh.md)

## Problem

A session model picker and a deployment default are two layers of the same preference. If the picker affects only its addressed session, the next blank session can select a different model with no user-facing way to align the default. If the default lives inside a Host gateway, direct Agent entry points cannot share it without depending on Host or duplicating state.

Reasoning effort makes the persistence shape significant: a model selection without an effort must clear a stored effort, or the next Agent may apply an effort that its selected model does not accept.

## Decision

`AgentDefaultModelConfig` provides `ctx.agentDefaultModel` and registers `{provider, model, reasoningEffort?}` as the `agent-default-model` Settings section. Its `{provider, model}` composition entry is the base layer and `settings.yaml` supplies the user layer. The service is entry-point-neutral, so direct creation and ApiProxy-backed creation share one default ([headless direct core entry point](../architecture/2026-08-09-headless-direct-core-entry-point.md)).

`reasoningEffort` belongs to the Settings section but not to the plugin config. Settings layers merge by field, so a configured effort would survive a user selection that omits it. `saveSelection()` instead writes the complete user section; absence therefore clears a stored effort. A deployment-wide effort default belongs to the adapter profile, which resolves it per model.

`session.selectModel` applies an accepted `ModelSelection` only to its addressed Agent and Session. The shared Agent default remains owned by the `agent-default-model` Settings section, so a Session choice cannot redirect future or uncommitted blank Sessions. A deployment with no settings provider retains the composition entry as its default.

`ApiProxyDefaults` carries only `defaultModelSelection()`, so `createApiProxy` has no dependency on the Settings seam. `ApiProxyService` wires it to `ctx.agentDefaultModel.currentSelection()`.

`selectionFor(agent)` reads the Agent-owned accepted intent and otherwise the live Agent default. An accepted intent remains durable even before a request consumes it. A blank Session observes the current default until its first Agent Turn materializes that value; this matches the New Session surface, which may reuse a blank Session.

The stored selection does not require catalog membership. A provider route may serve a model omitted from its advisory catalog. `session.models` therefore reports the stored selection independently of advertised groups and separately reports whether an adapter serves its provider.

## Consequences

`host.describe` reports the live Agent default. The model picker changes only the addressed Session; the `agent-default-model:` section in `settings.yaml` remains the explicit editor for future Sessions. The gateway does not expose that namespace through its Settings-page allowlist.

## A session that cannot send

`session.prompt` refuses with `model-unavailable` before opening a turn when no adapter serves the session's selected provider. This method is the enforcement boundary; a disabled composer is only a client affordance.

`session.models` reports `routable`. The ui-model-selection plugin projects an unroutable selection through `ctx.conversation.blocks`, and the composer becomes inert while leaving the model seat available. An unknown client-side routability state, including an initial or failed catalog load, does not block input.

Routability is distinct from catalog membership. A live provider route can serve an unadvertised model, so absence from catalog groups does not imply that the session is unusable.

## Alternatives considered

| Alternative | Contract mismatch |
|---|---|
| Fall back to the composition entry when the stored provider is unavailable | The product silently switches away from the user's selection. |
| Validate the stored selection against catalog membership | Catalogs are advisory and may omit requestable models. |
| Save with a merge patch | An omitted `reasoningEffort` cannot clear the stored field. |
| Save every session selection as the deployment default | One conversation would silently redirect unrelated future Sessions. |
| Require a separate “set as default” gesture in the picker | The default owner would become a second model-selection control inside a Session surface. |
