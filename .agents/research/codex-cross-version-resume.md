# Codex cross-version app-server thread resume for a production DSH driver

## Scope and source baseline

This report evaluates whether a production DeepSeek Harness Codex Agent Driver can intentionally use whichever `codex` executable is installed on the DSH host, persist a thread created by version N, and later use version N+1 (or an older version) to call app-server `thread/resume` on the same thread.

Only primary OpenAI sources are used. Codex 0.149.0 is the annotated release tag [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0), peeled to commit [`758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`](https://github.com/openai/codex/tree/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0). Current upstream was [`c9b19deb09c1841ce7acc33ddb96276030936a29`](https://github.com/openai/codex/commit/c9b19deb09c1841ce7acc33ddb96276030936a29) when researched. The two revisions are close, but the GitHub comparison reports that they have diverged rather than forming a simple release-to-HEAD ancestry: [0.149.0…current comparison](https://github.com/openai/codex/compare/rust-v0.149.0...c9b19deb09c1841ce7acc33ddb96276030936a29).

## Executive answer

A DSH driver **may opportunistically attempt** a cross-version resume using the host's current executable, but it should not treat that operation as an OpenAI compatibility guarantee. The official app-server documentation says the command is experimental and may change without notice, and generated protocol schemas are guaranteed only to match the exact Codex version that generated them ([CLI reference](https://developers.openai.com/codex/cli/reference), [app-server message schema](https://developers.openai.com/codex/app-server#message-schema)). Neither the protocol nor persisted thread metadata exposes a storage-format compatibility range or a negotiated minimum/maximum app-server protocol version.

For the specific 0.149.0-to-current pair examined here, **forward** resume is a reasonable transition to certify in DSH's own tests: both revisions have the same main SQLite migration ceiling (`0050`), the same thread-history migration ceiling (`0004`), and the same stable generated `ThreadResumeParams` TypeScript shape. The newer revision can read the older persisted model types examined. The reverse direction is materially different: current upstream relaxed persisted `FunctionCallOutput` so `call_id` may be absent/null and added `name`/`namespace`, while 0.149.0 requires `call_id`. That is strong evidence for this narrow forward pair, but also a concrete reason not to infer symmetric downgrade safety or a general promise for N-to-N+1 and large jumps.

A production driver should therefore use an **observe, certify, preflight, resume-or-fallback** policy rather than unconditional resume. DSH can use an unpinned host executable if it records the creating version and effective thread settings, snapshots Codex storage before allowing a new binary to open it, verifies the new binary's exact schema and required methods, validates the stored thread and model/provider availability, and refuses to start a turn when any check fails. Its durable recovery path should be a new Codex thread reconstructed from DSH-owned history, not repeated mutation of the original Codex store.

## What Codex persists

### Canonical history and queryable metadata

The official thread-store README says the local store persists canonical history in `codex-rollout` JSONL files and queryable metadata in SQLite when available. It also explicitly preserves JSONL/name-index compatibility so old or SQLite-less local storage can still be read ([0.149.0 thread-store README](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/README.md), [current thread-store README](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/thread-store/README.md)).

Rollouts are JSONL files under the Codex sessions directories. The recorder documents the canonical filename as `rollout-<timestamp>-<thread-id>.jsonl`; a reverted thread can use `rollout-<timestamp>-<thread-id>_<rollout-id>.jsonl` while keeping the thread ID stable ([0.149.0 recorder](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/recorder.rs)).

The first session metadata record includes:

- `session_id`, the live session-tree root;
- `id`, the durable thread ID;
- `cli_version`, the version that created the thread;
- optional `model_provider`;
- `history_mode`, defaulting to the legacy mode when absent;
- working directory, source, base instructions, dynamic tools, and other session metadata.

See the 0.149.0 [`SessionMeta`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/protocol/src/protocol.rs#L2871-L2958). App-server projects the creator version as `thread.cliVersion` and the provider as `thread.modelProvider` ([0.149.0 generated `Thread`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts), [current generated `Thread`](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts)).

### No explicit rollout compatibility version was found

The persisted session metadata records the creator's CLI version, but the rollout envelope and `SessionMeta` examined here do not carry a separate rollout schema version, minimum reader version, or compatibility range. This is a negative source finding, not proof that no internal compatibility convention exists. The consequence for an external driver is that `cliVersion` is evidence for policy decisions, not an OpenAI-declared statement that another version can safely read or append the rollout.

### Parsing is partly tolerant and therefore not intrinsically fail-closed

`RolloutRecorder::load_rollout_items` reads each JSONL line independently. Invalid JSON and rollout records that fail decoding increment a `parse_errors` counter and are skipped; the load continues. The counter is logged/returned internally but is not part of the normal app-server `thread/resume` response. An empty file fails. A rollout without a recoverable thread ID fails. Before the first session metadata record is decoded, an unknown or invalid `history_mode` is explicitly rejected ([0.149.0 rollout loader](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/recorder.rs#L1009-L1132)).

This tolerance helps read older history, but it is a downgrade and large-jump risk: an older reader can potentially skip newer records and resume with incomplete context instead of producing a clean incompatibility error. DSH must not use a successful JSON-RPC response alone as proof of complete history reconstruction.

There is a concrete incompatibility between the two revisions examined. In 0.149.0, persisted `ResponseItem::FunctionCallOutput` requires `call_id: String` ([0.149.0 model definition](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/protocol/src/models.rs#L1042-L1053)). Current upstream makes `call_id` optional and adds optional `name` and `namespace` ([current model definition](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/protocol/src/models.rs#L1052-L1071)); its tests construct a named function output with no `call_id` ([current compatibility test](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/protocol/src/models.rs#L3148-L3170)). A current-valid legacy JSONL record of that form cannot be fully decoded by 0.149.0 and can be skipped by the tolerant loader. This is a direct counterexample to blanket current-to-0.149.0 lossless downgrade compatibility.

## `thread/resume` behavior

The documented stable path is to record `thread.id` and later call `thread/resume` with that ID. A resume does not update the thread timestamp until a new turn starts. If a required MCP server fails initialization, `thread/resume` fails rather than continuing without it. If a different model is selected from the one recorded in the rollout, Codex emits a warning and adds a one-time model-switch instruction to the next turn ([official app-server resume documentation](https://developers.openai.com/codex/app-server#threads)).

The generated request type accepts three sources for non-running threads: caller-supplied history, a non-empty rollout path, or `threadId`, in that precedence order; it recommends `threadId`. It also accepts model, model-provider, service-tier, cwd, approval, sandbox/permission, config, instruction, and personality overrides ([0.149.0 `ThreadResumeParams`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts), [current `ThreadResumeParams`](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts)).

For a cold resume, 0.149.0 reads stored metadata/history, merges persisted model/provider/reasoning settings when the request did not override them, rebuilds current configuration through the normal config loader, creates a live writer, and returns the effective model, provider, cwd, approval policy, sandbox, and reasoning effort. Paginated local threads load their latest model context through the thread store; legacy threads reload history from JSONL ([0.149.0 `thread_resume_inner`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_processor.rs#L3479-L3835), [history-mode branch](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_processor.rs#L4214-L4260)).

The official documentation states that an app-server whose active store cannot support paginated history may list/read summaries but fails closed for full-history reads, pagination, and resume ([app-server thread history behavior](https://developers.openai.com/codex/app-server#threads)). The 0.149.0 and current local-store source includes paginated-resume logic, so the warning primarily matters when storage implementation or feature support differs.

## Migrations and storage mutation

### SQLite migrations are automatic on runtime initialization

`StateRuntime::init` opens and migrates the main state, logs, goals, memories, queue, and dedicated thread-history SQLite databases. The state wrapper also runs a rollout-to-SQLite metadata backfill and can time out waiting for it ([0.149.0 state runtime](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/src/runtime.rs), [0.149.0 rollout state-db initialization](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/state_db.rs)). A new executable can therefore mutate SQLite before DSH sends `thread/read` or `thread/resume`; a safe snapshot must happen before app-server startup.

Both 0.149.0 and the examined current commit embed main state migrations through [`0050_threads_section_empty_preview_indexes.sql`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/migrations/0050_threads_section_empty_preview_indexes.sql) and thread-history migrations through [`0004_thread_items_updated_at_ordinal.sql`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/thread_history_migrations/0004_thread_items_updated_at_ordinal.sql). The same paths exist at the current commit ([current state migrations](https://github.com/openai/codex/tree/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/state/migrations), [current thread-history migrations](https://github.com/openai/codex/tree/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/state/thread_history_migrations)).

### Newer-database tolerance is deliberate but narrow

The runtime migrator sets SQLx `ignore_missing = true` so an older binary can open a database containing migration versions newer than its embedded set. Known migration versions are still checksum-validated. The code comment says this deliberately relaxes only the “database is ahead of me” case ([0.149.0 migrations implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/src/migrations.rs)).

The originating official change explicitly says mixed-version CLIs can share the local state DB, but its follow-up warns that mixed-version local usage is not thereby “fully safe” ([official change `9bb8133`](https://github.com/openai/codex/commit/9bb813353ec73e8116ddea74de0d73fb80106b2d)). Tests prove only selected older-migrator behavior, such as an older pin-capable schema tolerating newer applied migrations ([0.149.0 migration tests](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/src/migrations_tests.rs)). This is not a downgrade promise for rollout semantics, app-server schemas, or future database queries.

### Legacy-to-paginated rollout migration is not default automatic behavior

`codex migrate-rollouts` inspects legacy rollouts by default and applies migration only with `--apply`; it supports thread filters, JSON reporting, and throughput limits ([0.149.0 CLI command registration](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/main.rs#L199-L205), [current command implementation](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/cli/src/migrate_rollouts.rs)).

A background startup migration exists, but `background_paginated_rollout_migration` is under development and disabled by default in both 0.149.0 and current ([0.149.0 feature registry](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/features/src/lib.rs#L993-L1005), [current feature registry](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/features/src/lib.rs#L1003-L1015)). When enabled and SQLite is available, the thread manager spawns it in the background and logs migration failure rather than blocking all startup ([0.149.0 thread manager](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/thread_manager.rs#L379-L401)).

The migration itself stages canonical JSONL, projects it into the dedicated history database, verifies it, atomically publishes it, and uses a durable `.pending` journal so an interrupted publish can be recovered ([0.149.0 rollout migration](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/src/local/rollout_migration.rs), [publish journal](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/src/local/rollout_migration/publish.rs), [startup recovery](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/src/local/rollout_migration/startup.rs)).

## Config and model-provider drift

Session metadata stores the provider, while later persisted thread metadata stores the selected model and reasoning effort. When no model override is present, resume merges the persisted model, provider, and reasoning effort into the new process's current configuration. Approval and permission-profile state is recovered from the latest persisted turn/settings events ([0.149.0 model/provider merge](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_processor.rs#L210-L228), [persisted approval settings](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/persisted_resume_settings.rs)). The 0.149.0 release notes specifically call out a fix ensuring resumed and forked threads restore their active permission profile instead of silently falling back to current defaults ([0.149.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.149.0)).

Provider definitions remain host configuration. `model_provider` selects an ID from `model_providers`; custom provider base URLs, authentication, headers, retry policy, and transport properties can change independently of the stored thread ([official config reference](https://developers.openai.com/codex/config-reference)). Therefore a provider name being present in history does not prove that N+1 can instantiate it. DSH should query `model/list` and `modelProvider/capabilities/read`, and should persist the effective start/resume response fields itself ([official app-server model APIs](https://developers.openai.com/codex/app-server#models)).

## Version-case evaluation

| Case | Evidence-based assessment | Production policy |
|---|---|---|
| Same-version restart | This is the documented purpose of `thread/resume`: record `thread.id`, restart app-server, and reopen the thread. Failures remain possible for missing/corrupt rollout data, locks, config/provider failure, required MCP startup failure, or unsupported store mode. | Supported after ordinary preflight; still validate the response before starting a turn. |
| 0.149.0 → examined current upstream | Strongly likely to work for ordinary local threads. The revisions share database migration ceilings and the stable resume request shape; the newer `FunctionCallOutput` reader accepts the older required-`call_id` form. App-server protocol files did change, so a driver compiled against a frozen aggregate schema can still break. | Reasonable to place in a DSH-certified transition matrix after fixture tests on copied Codex homes. Not an OpenAI guarantee. |
| Examined current upstream → 0.149.0 | Main/thread-history DBs are not ahead for this exact pair, and the older runtime intentionally tolerates newer migration versions in general. However, current-valid `FunctionCallOutput` records may omit `call_id`, which 0.149.0 requires; the older legacy reader can skip that undecodable line and continue with incomplete history. | Reject in place. Permit only against a restored pre-upgrade snapshot or after a DSH-certified downgrade fixture proves transcript equality for the exact record classes used. |
| Small future forward upgrade | SQLx automatically applies embedded migrations, optional fields/defaults and JSONL line tolerance often help, and newer code contains explicit legacy adapters. None of those mechanisms promises semantic preservation. | Snapshot first; require an allowlisted tested transition and full preflight. |
| Large forward jump | The new binary may run many automatic migrations and backfills and may rewrite rollout history if migration features/configuration changed. Old records may have adapters, but no compatibility range is advertised. | Unsafe by default. Canary on a copied home and fall back to a new thread unless certified. |
| Large downgrade | `ignore_missing` prevents one SQLite “DB ahead” error, but it cannot make newer columns, query assumptions, rollout items, history modes, permission profiles, models, providers, or protocol methods understandable to the older binary. Per-line skip behavior can hide loss. | Reject. Restore the entire pre-upgrade Codex-home snapshot before using the older binary, or create a new thread from DSH-owned history. |

## Capability negotiation: what exists and what is missing

The app-server initialize handshake returns `userAgent`, `codexHome`, `platformFamily`, and `platformOs`. Client capabilities include the experimental API opt-in and notification opt-outs. Experimental methods are rejected when the client did not opt in ([official initialize documentation](https://developers.openai.com/codex/app-server#initialize-the-connection), [0.149.0 generated `InitializeResponse`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-protocol/schema/typescript/InitializeResponse.ts)).

The following were not found in the official surfaces examined:

- negotiated app-server protocol version or version range;
- rollout/store format version or reader/writer compatibility range;
- “can resume thread created by CLI version X” capability;
- parse-error count in `thread/read` or `thread/resume`;
- a no-migration/read-only app-server startup mode for compatibility probing.

Schema generation is the strongest exact-runtime discovery mechanism: `codex app-server generate-ts` and `generate-json-schema` produce artifacts guaranteed to match that executable's version ([official schema documentation](https://developers.openai.com/codex/app-server#message-schema)). `model/list`, `modelProvider/capabilities/read`, `config/read`, `permissionProfile/list`, `thread/read`, and stable request rejection provide narrower runtime checks, but they do not prove storage compatibility.

## Failure modes relevant to DSH

1. **Thread not found or invalid ID:** local thread-store returns an invalid-request error such as “no rollout found for thread id …” or “invalid session id.” See [0.149.0 local read path](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/src/local/read_thread.rs) and [resume request validation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_processors/thread_processor.rs#L4214-L4295).
2. **Malformed or partially unsupported JSONL:** individual lines can be skipped; empty history or missing thread ID fails; invalid history mode fails early ([rollout loader](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/recorder.rs#L1009-L1132)).
3. **SQLite migration/checksum/backfill failure:** state runtime initialization can fail or time out. The ordinary state wrapper warns and can return `None`, allowing legacy JSONL fallback, but paginated history depends on the dedicated projection store ([state-db wrapper](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/rollout/src/state_db.rs)).
4. **Database lock:** Codex reports another process using local data and asks the user to close other copies ([0.149.0 state DB startup handling](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/state_db_recovery.rs)).
5. **Database corruption:** the CLI has targeted backup-and-rebuild support for a damaged runtime DB, moving the failed DB and sidecars to a backup directory ([recovery implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/state/src/runtime/recovery.rs)). A DSH app-server integration should not assume every startup path performs the same interactive recovery.
6. **Provider/model/config drift:** config loading can fail; an explicitly different model produces a warning and changes the next turn's instructions; a removed provider or unsupported effort can prevent equivalent continuation.
7. **Required MCP failure:** resume fails closed when a required enabled MCP server cannot initialize ([official app-server thread documentation](https://developers.openai.com/codex/app-server#threads)).
8. **Protocol drift:** current generated schemas are version-specific, and the official 0.149.0-to-current comparison already contains changes in aggregate app-server schemas and nested resume-history item definitions ([official comparison](https://github.com/openai/codex/compare/rust-v0.149.0...c9b19deb09c1841ce7acc33ddb96276030936a29)).

## Safe fail-closed design for an unpinned DSH driver

### Persist DSH-owned resume metadata

For every created/resumed Codex thread, DSH should durably record:

- `thread.id`, `thread.sessionId`, `thread.cliVersion`, and the app-server `userAgent`;
- canonical executable path and `codex --version` output at creation;
- `codexHome` returned by initialize;
- exact stable app-server schema fingerprint or a normalized required-surface fingerprint generated by that executable;
- effective model, provider, service tier, reasoning effort, cwd, approval policy, sandbox/permission profile, and required MCP identities returned by start/resume;
- DSH's own canonical transcript/event projection and a last-known turn/item fingerprint.

The DSH transcript is essential because Codex's reader can skip malformed/unknown lines without exposing the parse-error count over app-server.

### Preflight before the new executable touches the live store

1. Enforce single-writer ownership: no other Codex process may use the same `CODEX_HOME`.
2. Resolve the current host executable and collect `codex --version`.
3. Before launching app-server, create a restorable snapshot of the relevant Codex home, including sessions, archived sessions, SQLite DBs and sidecars, indexes, and rollout-migration journals. App-server startup can migrate SQLite before the first request.
4. Prefer a canary against a full copied Codex home when moving to an untested version. If credentials cannot safely be copied, copy storage into a protected test home and configure only the minimum authentication needed for local read/resume checks.
5. Generate the exact binary's stable app-server schema and reject the binary if required methods, request fields, response fields, notification types, or approval flows are missing or incompatible. Do not require an exact whole-schema hash when additive changes are acceptable; validate a DSH-owned required subset.
6. Maintain a DSH-tested transition matrix keyed by creator/runtime versions and schema fingerprints. An unknown transition is not automatically compatible merely because semver is close.

### App-server preflight before starting a turn

1. Initialize without experimental API unless DSH specifically requires a tested experimental field.
2. Verify returned `codexHome` is the intended store and that `userAgent` is consistent with the probed executable.
3. Call `thread/read` with turns included. Verify the ID, creator `cliVersion`, provider, cwd, expected terminal status, last known turn/item IDs, and DSH transcript fingerprint. Any missing or shortened history fails closed.
4. Call `model/list` and `modelProvider/capabilities/read`; require the recorded provider/model/effort or an explicitly approved replacement. If replacing a model, record that continuation is semantically changed.
5. Call `config/read` and, if used, `permissionProfile/list`; verify managed requirements, sandbox, approvals, writable roots, network policy, and required MCP configuration.
6. Call `thread/resume` with explicit safety-critical overrides rather than accepting changed host defaults. Validate every effective field in the response before `turn/start`.
7. Treat warnings, configuration warnings, unexpected notifications, state-DB fallback, required-MCP startup failure, or schema mismatches as hard failures.

### Failure and rollback policy

- On preflight failure, do not start a turn and do not repeatedly retry against the live store.
- Do not launch an older binary against a store already migrated by a newer binary as an automatic rollback. Restore the complete pre-upgrade snapshot first.
- If no certified cross-version path exists, start a new thread and reconstruct context from DSH's durable transcript, explicitly marking the Codex thread discontinuity.
- Preserve the failed store and diagnostic output for analysis; do not invoke destructive repair automatically from the agent driver.

## Recommendation

A production DSH Codex Agent Driver should **not promise transparent cross-version `thread/resume` using arbitrary host upgrades**. It may deliberately use the host's current `codex` executable without pinning only if cross-version resume is treated as a guarded optimization:

- same-version restart is the normal supported path;
- 0.149.0 to the examined current upstream is a good candidate for DSH certification because the relevant persistence migrations and stable resume shape match;
- downgrade is permitted only after restoring a pre-upgrade snapshot or passing an explicit certified downgrade fixture;
- unknown or large jumps fail closed to a new thread reconstructed from DSH-owned history.

The minimum production bar is: DSH-owned transcript durability, pre-launch storage snapshot, exact-runtime schema probing, a tested transition allowlist, model/provider/config checks, `thread/read` transcript verification, response validation before `turn/start`, and snapshot restoration rather than in-place downgrade. Without those controls, using an arbitrary upgraded executable to append to an older Codex rollout is not supported by any primary-source compatibility promise found in Codex 0.149.0 or current upstream.
