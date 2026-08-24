# @deepseek-ai/dsh-session-runtime

English | [中文](README.zh.md)

`ctx.sessionRuntimes` reports the current process-local execution state of durable Sessions without changing the binary `AgentStatus` completion contract. A Session may be cold, activating, available, or unavailable; live Agents contribute `idle`/`running` activity, while effect-scoped owners contribute activation phases and independent approval or user-input attention.

## Ownership

- `observe(header)` materializes a cold baseline and rejects an immutable Driver mismatch.
- `begin(header, spec)` creates one exclusive effect-scoped Driver activation contribution. Its returned capability alone changes phase, operation, Driver detail, or an unavailable diagnosis.
- `attend(header, kind)` contributes one independently disposable approval or user-input count.
- `agent/created`, `agent/status`, and `agent/disposed` supply live availability and activity automatically. A live Agent overrides an activation failure until that exact Agent is disposed.
- `setUnavailable()` retains a failed activation diagnosis after its contribution unwinds; `setCold()` clears it for an explicit retry or administrative reset.
- `session-runtime/status` publishes immutable whole values with process-local monotonic revisions. Ordinary observer failures are contained; invariant failures fan out and then rethrow.

Runtime status is not a Session-log projection. Replaying connecting, waiting, or process availability after restart would report resources that no longer exist. Durable Driver activation, model-request, activity, Objective, plan, and checkpoint facts use the statically known `agent-driver/*` Session events instead.

## Model Experience

None, as the registry only projects process-local availability and attention and registers no prompt section, tool schema, model message, stream middleware, or tool result.

#### KV Cache effect

None; the registry never assembles or sends a model request.

## Known Limitations and Deferred Work

- The registry is process-local and carries no cross-Host lease or authorization meaning.
- A persisted Session appears only after a Host consumer supplies its header to `observe()`; persistence listing remains the durable catalog.
- Missing Driver registrations and version incompatibility are diagnosed by the Host or selected Driver, then recorded through `setUnavailable()`; this service does not infer them from plugin presence.
