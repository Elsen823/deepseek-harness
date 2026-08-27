# Agent Note: Web model-selection identities

Status: implemented

English | [中文](2026-08-25-web-model-selection-identities.zh.md)

## Problem

The Web picker edits one DSH Session, but a running Turn can still be using an earlier accepted selection. A Codex-backed Session also has a native model and conversation identity that are not the DSH route. Combining these values into one model label hides whether a change is pending, which identity reached the model, and which native conversation the Driver owns.

## Decision

The runtime folds durable `model/selected`, `request/header`, `agent-driver/model-request`, and Driver activation evidence into a Session-local `ModelSelectionIdentity` projection. `Selected` is the latest accepted DSH provider/model and optional adapter-owned Reasoning Effort; `Effective` is the latest request evidence; `Next turn` appears only when the accepted value differs from the latest effective value. The fold carries the DSH Session id independently from an optional native conversation id, and it carries native model/effort only when Driver evidence supplies them.

The ui-model-selection plugin renders these values in the session header as separate `Selected`, `Next turn`, `Effective`, `Native`, `DSH Session`, and native conversation rows. Reasoning Effort remains an attribute of the DSH or native selection and is never presented as a model. A selection made while a Turn runs therefore leaves the current Effective row visible and labels the accepted value `Next turn` until a later request evidence event consumes it.

The picker remains Session-local: `session.selectModel` addresses the Agent and Session in the request, while Models settings owns the default for future or uncommitted blank Sessions. The directory keeps Driver-incompatible model and effort rows visible with their reasons but disables them, and it remains available when the current provider route is unavailable so a user can recover by choosing a compatible row. Directory state is scoped by Session id, so concurrent Sessions retain independent selections; reconnect and reload restore Host state before a first request.

## Alternatives considered

**Collapse DSH and native identities into one model label.** A native Driver can map a DSH route to a different native model or conversation, so a merged label would make agreement and divergence impossible to inspect.

**Show only the latest effective request.** This loses an accepted selection before its first request and hides a pending change during a running Turn. The durable Selected projection and the derived Next turn row preserve both facts.

**Treat Reasoning Effort as another model.** Effort is adapter-owned metadata on a DSH or native selection, not a route identity. Keeping it as a separate row prevents provider/model labels from claiming an effort is a model.

**Disable the picker when the current provider is unavailable.** Recovery requires the user to choose a route that can be served, so the picker remains interactive while the composer availability block communicates the current route failure.

**Write a picker choice to the deployment default.** A Session-local change must not redirect another Session or a future blank Session; Models settings remains the sole default owner.

## Consequences

Web users can inspect the DSH Session, accepted intent, pending next-Turn value, effective request, native Driver mapping, and native conversation independently. The projection is reconstructable from the Session event window and does not add model-visible input. Native rows are absent until the Driver emits evidence, and an effective row can remain unchanged while a new selection waits for the next request.

## Testing

Runtime and component tests pin independent Selected/Next turn/Effective folds, native and conversation identities, omission of Reasoning Effort as a model, and stable projections for unrelated events. Browser-plugin tests exercise two concurrent Sessions, reload before first use, provider failure recovery, incompatible rows, and running-Turn transitions through the real client plugin registration path. The assembled keyless browser snapshot at [`apps/web/tests/model-selection-identities.snapshot.ts`](../../../../apps/web/tests/model-selection-identities.snapshot.ts) mounts the Session-local header and picker contracts and records the built-in DSH identity labels.

## Deferred

Driver-specific activity layouts may add richer native diagnostics, but they consume the same DSH Session and native identity fields. Cross-Driver identity mapping remains owned by each Driver; the Web model-selection package does not infer aliases or native conversation ids from catalog names.
