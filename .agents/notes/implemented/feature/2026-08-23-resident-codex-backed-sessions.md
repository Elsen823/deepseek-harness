# Agent Note: Resident Codex-backed Sessions

Status: implemented

English | [中文](2026-08-23-resident-codex-backed-sessions.zh.md)

## Problem

The existing Codex subagent integration intentionally starts one fresh product process for one delegated task, returns a final result, and tears the process down. That remains correct for the [Codex subagent backend](2026-08-04-claude-code-and-codex-subagent-backends.md), but it cannot make Codex the execution implementation for a durable DSH Session with resume, streaming activity, interactions, cancellation, and native work state.

A resident integration must also keep DSH-configured model routes and credentials in DSH while Codex runs on the Host. Codex app-server schemas and native persistence are version-specific, so activation must prove the exact supported runtime instead of treating a successful `thread/resume` as a broad compatibility promise.

Primary-source constraints and adjacent-version evidence remain in the [cross-version resume report](../../../research/codex-cross-version-resume.md), [shared resident service report](../../../research/codex-shared-app-server-remote-clients.md), and [native Goal and Plan report](../../../research/codex-goals-plans-dsh-integration.md). The generic lifecycle is owned by [Session-bound Agent Drivers](../architecture/2026-08-23-session-bound-agent-driver-registry.md), and generic runtime and work state are owned by [Driver-neutral Session runtime and work-state projections](../architecture/2026-08-23-driver-neutral-session-runtime-and-work-state.md).

## Decision

### External hybrid package and resident daemon

The implementation is the external hybrid package `@dsh-external/dsh-codex-agent-driver` at `/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver`, with Host and Web entries. It registers the `codex` Agent Driver, the authenticated Responses Bridge, interaction handlers, Driver activity presentation, Driver selection, runtime presentation, and native work-state presentation without adding Codex-specific branches to the built-in DSH loop.

The plugin is a client of the official resident Codex daemon; it does not own the daemon process. Plugin reload, Driver disposal, browser disconnect, and DSH shutdown release DSH connections and activations without treating the daemon as a Cordis child process. Operator setup, update, rollback, and SSH configuration use the official daemon wizard rather than custom systemd or launchd units.

### One trusted OS and `CODEX_HOME` domain

One operating-system identity and `CODEX_HOME` form one fully trusted domain. Clients in that domain share filesystem authority, Codex configuration, native Thread catalog, provider routing reachability, and model-spend consequences. Activation credentials identify attributed DSH lifecycles and support correlation, accounting, cancellation, and revocation; they do not isolate mutually trusted clients from one another. A narrower trust requirement uses a separate OS identity and `CODEX_HOME`.

Remote human use runs the Host-side Codex TUI through SSH. Orca uses its remote terminal and SSH workflow rather than acting as an app-server protocol client. The integration does not expose the resident daemon as a general network WebSocket service.

### Exact stable Codex protocol

The package supports the exact Codex `0.149.1` host and generated schema hash recorded by its compatibility profile. Load-time admission hashes the configured CLI and adjacent executable `codex-code-mode-host`, reads the running daemon descriptor, requires byte-identical managed CLI and sidecar binaries on the configured socket, and proves all executable identities remain stable while the sidecar help, CLI version, and schema checks run. Every Session activation revalidates those identities before connecting. It uses the stable API only (`experimentalApi: false`) over WebSocket on the owner-controlled Unix socket. Client methods and first-class notification projections are exact allowlists; unknown server requests and unknown model-visible items fail closed, while bounded unknown informational notifications remain fallback activity.

A fresh DSH Session starts one persistent Codex Thread. Resume uses the native Thread id recorded in Agent Driver activation and checkpoint events and accepts same-version state only after exact distribution admission plus a non-subscribing `thread/read` identity check. A version or schema mismatch, missing Thread, identity mismatch, or rejected read/resume records explicit reconstruction into a new Thread from sanitized portable DSH user/assistant text and user images; reasoning, commands, approvals, native tools, tool results, and side effects are not replayed.

The official daemon wizard owns setup, version update, rollback, and SSH guidance. The plugin never performs an implicit native-state migration or installs its own service manager.

### Authenticated DSH Responses Bridge

Codex receives a per-activation Responses provider whose authenticated loopback endpoint is hosted by the plugin. The Bridge resolves and executes model calls through `ctx.llm`, so provider credentials and Model Route ownership remain in DSH. Loopback source is not authorization; the command-backed activation credential is checked for every Bridge request and removed on disposal.

Codex `request_max_retries` and `stream_max_retries` are both `0`. The Bridge executes the retry policy captured by DSH, records exact model-visible requests and every attempt through static Agent Driver events, streams supported Responses output, reports usage, and propagates cancellation. Unsupported request content or route capabilities fail before unsafe native execution.

### Session, interaction, and work-state mapping

One native Codex turn maps to one DSH Turn. Accepted user messages and final assistant answers use core conversation semantics; native commands, file changes, diffs, MCP calls, reasoning summaries, status, partial progress, and errors use Driver activity snapshots. Approval and user-question requests route through DSH interaction services, contribute independent runtime attention counts, and fail closed for unknown request methods.

Codex native Goal snapshots project to the portable Objective without creating DSH `goal/change`. Stable native plan updates project to the portable Checklist without mounting `todo_write`, and completed plan documents project to Proposed Plan. Built-in DSH Goal, Plan Mode, and permission presets own only `dsh` Sessions; cross-Driver forks omit their control events and the composer hides their controls for alternate Drivers. The shipped Web integration provides the Driver selector, runtime badge, activity view, Objective dock, Checklist through the native projection, and Proposed Plan dock. It does not claim or render native collaboration-mode UI.

## Alternatives considered

**Reuse the one-shot subagent provider.** Its fresh-process, final-result lifecycle deliberately has no durable parent Session ownership, interactive timeline, or native resume.

**Start one app-server per Session.** That discards the official resident daemon model, multiplies process and update state, and prevents the trusted Host-side TUI workflow from sharing the same native service.

**Let the plugin own the resident daemon.** Cordis disposal would either terminate an operator-owned service or leave an unowned process. Daemon lifecycle belongs to the official operator workflow outside the plugin.

**Install custom systemd or launchd units.** That would duplicate the official daemon setup, update, rollback, and SSH workflow and create a second lifecycle authority.

**Claim per-activation isolation inside one daemon.** Activation credentials provide attribution and cancellation, but the shared OS identity and `CODEX_HOME` retain common native authority. Isolation requires a distinct trusted domain.

**Use Codex account credentials directly for model calls.** That bypasses DSH Model Routes, adapters, retry policy, usage ownership, and credentials policy. The Responses Bridge keeps those responsibilities in DSH.

**Treat successful `thread/resume` as cross-version proof.** Native persistence may be accepted while records are skipped or reinterpreted. Exact same-version admission and explicit reconstruction avoid that unsupported promise.

**Expose native collaboration mode because native plans exist.** Checklist progress and completed Proposed Plans are shipped, but no native collaboration-mode control and Web UI are present. The integration does not infer one from plan events.

## Consequences

Codex-backed and built-in DSH Sessions coexist in one profile and retain immutable Driver bindings. The external package must track the exact Codex schema and stable API; another Codex version remains unavailable until the package is deliberately updated, or the user reconstructs into a new native Thread.

The trusted-domain model is intentionally coarse. Credentials improve attribution, cancellation, accounting, and audit but do not create client isolation. The official daemon and SSH workflow remain independent of plugin reloads, while DSH retains authority over model routing and reconstructable requests.

Native activity gives the Web a richer timeline without converting provider operations into DSH tools or injecting intermediate process narration into portable conversation history. Objective, Checklist, and Proposed Plan remain read projections with native execution ownership; native collaboration-mode UI remains absent.

## Verification

The external package pins Codex `0.149.1`, its adjacent executable code-mode host, the exact generated schema hash, stable-only initialization, Unix-socket transport, method allowlists, same-version create/resume, unknown-transition reconstruction, authenticated Bridge access, `ctx.llm` routing, Codex retry counts of zero, DSH retry replay, cancellation, interactions, activity, native Objective/Checklist/Proposed Plan projection, and Web registration. Package tests cover compatibility admission, the JSON-RPC peer, the real resident daemon, Bridge wire and HTTP behavior, Driver lifecycle, projection mapping, interaction handling, and activity presentation.
