# Agent Note: Plugin-owned session event vocabulary

Status: implemented

English | [中文](2026-08-30-plugin-session-event-vocabulary.zh.md)

## Problem

An external plugin can extend `SessionEventMap` at compile time and append its events while the process is live, but the generated `KNOWN_SESSION_EVENT_TYPES` set contains only declarations in this repository. Persistence therefore refused every external event after restart. A main-agent driver needs required durable facts such as its Session binding and native checkpoint, while UI and telemetry integrations also benefit from observational events whose absence does not change Session reconstruction. Patching each external event into the Harness repository would turn deployment plugins back into a long-lived fork; accepting every unknown event would silently resume without required state.

The [fail-closed event-vocabulary decision](../simplification/2026-08-25-fail-closed-session-event-vocabulary.md) deliberately removed an unused skip marker and deferred registration until a real external producer could define required and optional semantics. The external main-driver migration supplies that producer, so the default refusal remains necessary while the deferred extension mechanism becomes concrete.

## Decision

**Known event types are the union of repository declarations and effect-scoped external registrations.** `KNOWN_SESSION_EVENT_TYPES` remains the generated, composition-independent set for first-party declarations. An external plugin calls `ctx.sessions.registerEventType(type)` from its own Cordis scope for every event whose meaning is required on resume. The name must be slash-qualified, cannot collide with a first-party type or another active registration, and disappears when the owning scope unloads. Persistence accepts a required external event only while that registration is active; a missing plugin therefore refuses the Session with `SessionFormatUnsupportedError` instead of reconstructing incomplete state.

**Optionality is an assertion on the stored event envelope.** `Session.append()` accepts `ignorable: true` for an event whose semantics are observational and whose omission cannot alter model history, request reconstruction, recovery, authorization, or another required plugin projection. Absence means required-on-read. The coordinator accepts an unregistered event only when its stored envelope carries the literal `true`; it never infers safety from an unfamiliar name. Readers retain accepted ignorable events verbatim, so reinstalling the plugin can project them later.

The envelope assertion survives seed validation, JSONL records, Session Controller wire history, and SQLite scalar rows. SQLite schema 20 gives `ignorable` a separate `0 | 1` column instead of overloading the packed-row discriminator; packed first-party chunk runs require `0`. `SESSION_FORMAT_VERSION` remains `0` under the pre-release policy: an older build fails loud on the new envelope member, and SQLite rejects every older schema rather than migrating it.

Required main-driver binding and checkpoint events remain unmarked and are registered before any resume. Driver activity, diagnostics, or other records that do not participate in reconstruction carry `ignorable: true`. This classification belongs to each producer's durable-event design; the marker is not a compatibility escape hatch for state a plugin merely finds inconvenient to restore.

## Alternatives considered

**Generate external event names into the Harness known set.** Rejected because every plugin release would require an upstream source change, and a build would claim it understands an event even when its consumer is not installed.

**Accept every declaration-merged or slash-qualified event.** Rejected because TypeScript declarations do not exist in a persisted reader process, and naming syntax cannot prove that ignoring an event preserves reconstruction.

**Put optionality only on the runtime registration.** Rejected because the safety fact must travel with the durable record. A Session may be copied to a composition where the writer plugin is absent, and that reader needs a persisted distinction between required and observational data before it can load the Session.

**Require registration for ignorable events.** Rejected because absence of the declaring plugin is exactly the supported read case. Active plugins may still register their required types, while the persisted assertion is sufficient for observational records.

**Use a Session header driver id to decide which event vocabulary to load.** Rejected because event ownership is not limited to drivers, multiple independent plugins can contribute durable facts, and a header discriminator would couple the core Session identity to one extension family.

## Consequences

External plugins can own durable state without adding their event names to the Harness repository. Required state continues to fail closed when the plugin is missing; observational history remains readable across plugin removal. The same stored Session may therefore load or refuse according to the active required-event registrations, which is intentional composition validation rather than format guessing.

The event envelope, transport, and SQLite schema gain one field, and every backend must preserve it exactly. Producers must make an explicit safety decision for each ignorable append. Core tests pin registration ownership, duplicate and built-in rejection, seed validation, and append defaults; the shared persistence contract pins registered-required acceptance, post-unload refusal, and unregistered-ignorable acceptance; SQLite codec and corruption tests pin scalar round trips and packed-row rejection.
