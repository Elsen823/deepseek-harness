# Agent Note: Resident Codex-backed Sessions

Status: implemented

English | [中文](2026-08-23-resident-codex-backed-sessions.zh.md)

## Problem

The existing Codex subagent integration intentionally starts one fresh product process for one delegated task, returns a final result, and tears the process down. That remains correct for the [Codex subagent backend](2026-08-04-claude-code-and-codex-subagent-backends.md), but it cannot make Codex the execution implementation for a durable DSH Session with resume, streaming activity, interactions, cancellation, and native work state.

A resident integration must also keep DSH-configured model routes and credentials in DSH while Codex runs on the Host. Codex app-server schemas and native persistence can vary by installed runtime, so activation must attest the required behavior and native-state ownership instead of treating a successful `thread/resume` as a broad compatibility promise.

Primary-source constraints and adjacent-version evidence remain in the [cross-version resume report](../../../research/codex-cross-version-resume.md), [shared resident service report](../../../research/codex-shared-app-server-remote-clients.md), and [native Goal and Plan report](../../../research/codex-goals-plans-dsh-integration.md). The generic lifecycle is owned by [Session-bound Agent Drivers](../architecture/2026-08-23-session-bound-agent-driver-registry.md), and generic runtime and work state are owned by [Driver-neutral Session runtime and work-state projections](../architecture/2026-08-23-driver-neutral-session-runtime-and-work-state.md).

## Decision

### External hybrid package and resident daemon

The implementation is the external hybrid package `@dsh-external/dsh-codex-agent-driver` at `/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver`, with Host and Web entries. It registers the `codex` Agent Driver, the authenticated Responses Bridge, interaction handlers, Driver activity presentation, Driver selection, runtime and identity presentation, native work-state presentation, the read-only TUI observer, and the Other CLI Host-management settings without adding Codex-specific branches to the built-in DSH loop.

The official Codex resident manager owns the daemon process. After the configured CLI, code-mode sidecar, descriptor, schema, and behavior probes pass admission, `start-if-absent` may invoke the manager's idempotent `daemon start`; `require-running` leaves startup to the operator. A loopback-only, confirmation-gated settings operation may invoke `daemon restart` after current-generation identity preflight, a zero-live-Agent and zero-attention check, and explicit candidate admission, then revalidates the returned daemon with a fresh initialize/initialized handshake and behavior probes. Plugin reload, Driver disposal, browser disconnect, and DSH shutdown release DSH connections and activations without stopping the shared daemon or treating it as a Cordis child process. The plugin never runs daemon bootstrap or enables remote control. Operator setup, external version transition, rollback, and SSH configuration use the official daemon wizard rather than custom systemd or launchd units.

### One trusted OS and `CODEX_HOME` domain

One operating-system identity and `CODEX_HOME` form one fully trusted domain. Clients in that domain share filesystem authority, Codex configuration, native Thread catalog, provider routing reachability, and model-spend consequences. Activation credentials identify attributed DSH lifecycles and support correlation, accounting, cancellation, and revocation; they do not isolate mutually trusted clients from one another. A narrower trust requirement uses a separate OS identity and `CODEX_HOME`.

Remote human use of a native Codex TUI runs through SSH and must not attach as a second writer to a Thread actively owned by DSH. Orca uses its remote terminal and SSH workflow rather than acting as an app-server protocol client. The browser TUI reads the durable DSH conversation and Driver Activity projections; it is neither a native Codex TUI nor another app-server client. The integration does not expose the resident daemon as a general network WebSocket service.

The Host catalog contains the current DSH candidate plus explicit additional `CODEX_HOME`, CLI, and socket candidates. It does not scan processes or infer independent daemon homes from ambient sockets. Additional candidates are observed without starting them. The Web marks the primary entry `(This DSH)` and reports running, unavailable, or incompatible state. For each running Host it lists the current process's live Codex Agents with DSH Session, native Thread, DSH model route, activity, and attention identities. An idle Agent can be released only when the current ApiProxy retains its exact handle; release preserves the durable Session. Restart gates new current-Host preparations, waits for an entered preparation to reach publication or rollback, and is then refused while this DSH process has live Codex Agents or pending attention. The explicit acknowledgement also warns that clients outside this process cannot be enumerated and will disconnect.

An explicitly resident Codex Session also participates in the generic [process-generation restart handoff](../architecture/2026-08-26-process-generation-restart-handoff.md). The handoff sidecar binds the Session checkpoint, Driver, model selection, and native Thread state; a compatible next generation uses non-subscribing read/resume without `dispose()`, teardown events, or `thread/unsubscribe`, while a failed bounded handoff leaves the old generation serving.

### Capability-attested stable Codex protocol

The package carries generated protocol schemas and an observed-version baseline as build provenance, not as a fixed runtime release requirement. Load-time admission hashes the configured CLI and adjacent executable `codex-code-mode-host` and proves their identities remain stable while the sidecar help, CLI version, and schema checks run. Only then may startup policy act on an unavailable daemon. Admission reads the running daemon descriptor, requires dynamic CLI/daemon descriptor consistency, the configured socket, byte-identical managed CLI and sidecar binaries, and stable identities. Every Session activation revalidates the current generation before connecting. A controlled restart intentionally resolves the externally installed executable at the configured path, then admits the new generation through fresh transport and behavior probes; an incompatible or behavior-incomplete runtime fails closed while preserving DSH and native durable state. It uses the stable API only (`experimentalApi: false`) over WebSocket on the owner-controlled Unix socket. Client methods and first-class notification projections are exact allowlists; unknown server requests and unknown model-visible items fail closed, while bounded unknown informational notifications remain fallback activity.

A fresh DSH Session starts one persistent Codex Thread. Resume uses the native Thread id recorded in Agent Driver activation and checkpoint events and accepts state only after runtime capability attestation plus a non-subscribing `thread/read` identity check. A missing or incompatible behavior, missing Thread, identity mismatch, or rejected read/resume records explicit reconstruction into a new Thread from direct user messages, visible assistant text, and user images in portable DSH history. Plugin-authored context, reasoning, commands, approvals, native tools, tool results, and side effects are not replayed.

The official daemon wizard owns setup, version update, rollback, and SSH guidance. The plugin never performs an implicit native-state migration or installs its own service manager.

An unavailable native conversation does not transparently start an interactive `codex resume`. Interactive CLI activity would be a second Thread writer outside the DSH Session log. Recovery remains inside the Driver's exact continuation and explicit reconstruction behavior.

Opening the browser TUI does not activate an Agent or start a model Turn. It folds durable user and assistant conversation nodes, the current streamed assistant projection, and sanitized Driver Activity into one terminal-style timeline. It has no shell, PTY, writable RPC, or process controls. The resident composer is absent while TUI is selected and returns with Chat; Chat is the only Web input path and the Driver remains the Codex Thread's only writer.

### Authenticated DSH Responses Bridge

Codex receives a per-activation Responses provider whose authenticated loopback endpoint is hosted by the plugin. The Bridge resolves and executes model calls through `ctx.llm`, so provider credentials and Model Route ownership remain in DSH. Loopback source is not authorization; the command-backed activation credential is checked for every Bridge request and removed on disposal.

The Driver sends only direct user-authored Chat messages to native Codex turn and steering methods. It does not invoke the DSH `agent/pre-step` waterfall, assemble a DSH system prompt, or pass plugin-authored context such as memory recall, skill catalogs, and permission reminders to Codex. Codex owns its native instructions, `AGENTS.md`, tools, skills, and execution loop; DSH owns model routing, authenticated transport, accepted-message persistence, interaction forwarding, and Chat projection.

An explicit `$name` in direct Chat text is resolved against native `skills/list` for the Session working directory. The Driver preserves the complete text and adds native skill input only for enabled exact matches, using the name and absolute path returned by Codex. Unknown and disabled names remain text. Skill discovery and instruction loading stay in Codex rather than becoming DSH prompt assembly.

Codex `request_max_retries` and `stream_max_retries` are both `0`. The Bridge executes the retry policy captured by DSH, records exact model-visible requests and every attempt through static Agent Driver events, streams supported Responses output, reports usage, and propagates cancellation. Unsupported request content or route capabilities fail before unsafe native execution.

### Session, interaction, and work-state mapping

One native Codex turn maps to one DSH Turn. Accepted user messages and final assistant answers use core conversation semantics; native commands, file changes, diffs, MCP calls, reasoning summaries, status, partial progress, and errors use Driver activity snapshots. Approval and user-question requests route through DSH interaction services, contribute independent runtime attention counts, and fail closed for unknown request methods.

Codex native Goal snapshots project to the portable Objective without creating DSH `goal/change`. Stable native plan updates project to the portable Checklist without mounting `todo_write`, and completed plan documents project to Proposed Plan. Built-in DSH Goal, Plan Mode, and permission presets own only `dsh` Sessions; cross-Driver forks omit their control events and the composer hides their controls for alternate Drivers. The shipped Web integration provides the Driver selector, a red/yellow/green sidebar state marker, a runtime badge carrying DSH Session, native Thread, and DSH route identities, the activity view, Objective dock, Checklist through the native projection, Proposed Plan dock, the read-only TUI observer, and Other CLI settings with Codex and reserved Grok tabs. It does not claim or render native collaboration-mode UI.

## Alternatives considered

**Reuse the one-shot subagent provider.** Its fresh-process, final-result lifecycle deliberately has no durable parent Session ownership, interactive timeline, or native resume.

**Start one app-server per Session.** That discards the official resident daemon model, multiplies process and update state, and prevents the trusted Host-side TUI workflow from sharing the same native service.

**Treat the daemon as a Cordis-owned child process.** Cordis disposal would terminate a shared service or leave a detached child. The plugin may request bounded official manager operations, but it never owns daemon lifetime or stops the daemon during unload.

**Discover arbitrary app-server processes.** A process id does not certify the `CODEX_HOME`, managed binary, socket, protocol version, or trust domain required for attachment. The catalog uses explicit candidates and official daemon descriptors.

**Fallback to interactive `codex resume`.** That process would write native Thread state without projecting its model-visible activity through the DSH Session log, creating ambiguous ownership and non-reconstructable history.

**Embed a writable Codex CLI or DSH shell in the browser TUI.** A second input and process-control path would split conversation authority from Chat and could create activity outside the durable DSH projections. The TUI observes the existing projections without owning execution.

**Restart after the configured binary changes.** Interrupting the compatible resident daemon before the replacement distribution and state transition are certified can strand every shared client. DSH verifies the still-running old generation, then intentionally admits the externally installed candidate at the configured path and requires fresh transport and behavior probes after restart; the wizard never bypasses the live-Agent or pending-attention check.

**Install custom systemd or launchd units.** That would duplicate the official daemon setup, update, rollback, and SSH workflow and create a second lifecycle authority.

**Claim per-activation isolation inside one daemon.** Activation credentials provide attribution and cancellation, but the shared OS identity and `CODEX_HOME` retain common native authority. Isolation requires a distinct trusted domain.

**Use Codex account credentials directly for model calls.** That bypasses DSH Model Routes, adapters, retry policy, usage ownership, and credentials policy. The Responses Bridge keeps those responsibilities in DSH.

**Treat successful `thread/resume` as compatibility proof.** Native persistence may be accepted while records are skipped or reinterpreted. Capability and behavior attestation plus explicit reconstruction avoid that unsupported promise without requiring exact version equality.

**Expose native collaboration mode because native plans exist.** Checklist progress and completed Proposed Plans are shipped, but no native collaboration-mode control and Web UI are present. The integration does not infer one from plan events.

## Consequences

Codex-backed and built-in DSH Sessions coexist in one profile and retain immutable Driver bindings. Build-generated schemas remain useful provenance, while runtime admission accepts additive Codex versions when the required capabilities and behavior probes pass. A missing or incompatible capability remains unavailable and preserves native/DSH durable state for explicit reconstruction into a new Thread.

The trusted-domain model is intentionally coarse. Credentials improve attribution, cancellation, accounting, and audit but do not create client isolation. The official daemon and SSH workflow remain independent of plugin reloads, while DSH retains authority over model routing and reconstructable requests. Automatic startup covers an absent compatible primary daemon without making unload destructive. Other daemon homes require explicit catalog entries, and restart remains unavailable while the current DSH Host owns live Agents.

Native activity gives the Web a richer timeline without converting provider operations into DSH tools or injecting intermediate process narration into portable conversation history. Objective, Checklist, Proposed Plan, and TUI remain read projections with native execution ownership; native collaboration-mode UI remains absent.

## Verification

The external package attests the configured CLI, adjacent executable code-mode host, dynamic CLI/daemon descriptor consistency, stable-only initialization, Unix-socket transport, required behavior probes, method allowlists, compatible create/resume, unknown-transition reconstruction, authenticated Bridge access, `ctx.llm` routing, Codex retry counts of zero, DSH retry replay, cancellation, interactions, activity, native Objective/Checklist/Proposed Plan projection, and Web registration. Package tests cover compatibility admission before automatic startup, no-op startup for a running daemon, same-path candidate replacement, post-cutover evidence invalidation, restart preflight and postflight, Host-state classification, live-Agent and pending-attention restart refusal, loopback RPC request validation, Other CLI tabs and confirmation, Session identity and sidebar state, direct Chat forwarding without DSH pre-step or plugin context, cwd-specific native skill resolution for starting and steering input, unknown and disabled skill text, reconstruction filtering, read-only TUI ordering and omission of DSH context and writable controls, the absence of terminal RPC methods, the JSON-RPC peer, behavior-compatible and incompatible fake Host generations, the real resident daemon, Bridge wire and HTTP behavior, Driver lifecycle, projection mapping, interaction handling, and activity presentation.
