# Agent Note: Agent-owned Turn Model Selection

Status: implemented

English | [中文](2026-08-25-agent-owned-turn-model-selection.zh.md)

## Problem

An Agent Driver and the Host must observe the same Session-local model choice, including a choice accepted before the first model request. Treating request evidence as intent loses that first choice and conflates the requested route with the route that a Driver resolves for a particular Turn. A Session choice must also remain separate from the deployment default used by future Sessions.

## Decision

`ModelSelection` contains exactly one DSH Model Provider, one provider-owned model, and optional adapter-owned `reasoningEffort`. Service tier, Advanced Model Config, sampling, tools, approvals, sandbox policy, permissions, and native Driver settings retain their existing owners.

Each live `Agent` carries one Session-local `modelSelection` owner. A Driver constructs that owner for the exact Session before publication, and `AgentRegistry` rejects an Agent that does not provide it. No Host-local map, module-local map, prompt listener, request listener, or compatibility adapter owns or routes Model Selection.

The owner exposes accepted `selected` intent, separate `effective` evidence, an uncommitted `defaultSelection`, validation, acceptance, default updates, and frozen `beginTurn()` values. Acceptance validates the three Model Selection fields and appends `model/selected` immediately with source `user` or `default`; an identical accepted value is a no-op. `beginTurn()` materializes an inherited default only at Turn start, resolves adapter defaults once, and returns one frozen value. A selection that omits effort does not retain an effort from an earlier model.

The built-in `dsh` Driver captures the resolved value once before prompt assembly and supplies it to prompt variables and every request in that Turn. Acceptance is serialized with this capture; a change during a running Turn applies to the next Turn, and steering continues with the captured value. Provider/model incompatibility is validated before model I/O and before an inherited default is committed, so recovery can repair the route without mutating accepted intent. Codex constructs the same owner directly, maps each frozen Turn to its native identity, and rejects unsupported provider/model/effort combinations before native or provider I/O.

`Session` validates `model/selected` at append and restore boundaries and folds it independently from `request/header` and `agent-driver/model-request` evidence. `session.selectModel` accepts intent on the addressed Agent and Session without changing the deployment default; a blank Session reads the live default until its first Turn materializes it. Web presentation distinguishes selected, next-turn, native, effective, DSH Session, and native conversation identities. TypeScript and Python SDKs preserve the event vocabulary and expose selected-intent projections without treating effective request evidence as intent.

## Alternatives considered

**Store selection in a Host-local map.** A Driver resolved from another installed package copy could address a different map entry. The Agent instance is the shared owner across package copies and lifecycle callers.

**Use request evidence as the selected value.** A request records a route that reached the model boundary and cannot represent an accepted selection before the first request. `model/selected` records intent, while request headers and Driver model-request records remain effective evidence.

**Let a Session choice change the deployment default.** A conversation-local decision would silently redirect unrelated future Sessions. The addressed Session owner and the deployment default remain separate.

**Put service tier or Advanced Model Config in `ModelSelection`.** Those values have separate adapter, settings, or Driver ownership and would make one selection event carry unrelated request controls. The selection event admits only provider, model, effort, and source.

**Route through prompt assembly or request middleware.** Those waterfalls assemble or mutate request envelopes and cannot guarantee one immutable route across native and DSH Turns. The Agent-owned owner captures and resolves the route at Turn start, before the Driver performs model I/O.

## Consequences

An accepted selection survives restore even when no request consumed it, and consumers can distinguish it from the latest effective provider/model/effort. Every current Agent Driver has one explicit owner and fails at publication when it omits one. Repeated identical choices do not grow the log, and omitting effort does not retain stale adapter state. Session-local choices never redirect unrelated future Sessions.

## Testing

Agent tests cover owner attachment, publication rejection, durable intent, default materialization, frozen Turn values, duplicate no-op acceptance, and failure before model I/O. DSH loop tests cover prompt/request identity, one-Turn steering, effort default clearing, cancellation and prepared-failure evidence, unavailable routes, and keyless assembled output. Codex tests cover direct owner construction, native route mapping, identity projection, and unsupported routes. Session tests cover independent selected/effective folds, malformed append/restore payloads, and same-Driver fork retention. Host, TypeScript SDK, and Python SDK tests cover acceptance, validation, and projections. Keyless assembled and browser fixtures assert selected intent before the first effective request evidence.
