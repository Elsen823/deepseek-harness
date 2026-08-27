# Agent Note: Reviewed source-to-artifact baseline for the Codex Agent Driver

Status: implemented

English | [中文](2026-08-25-reviewed-codex-driver-source-artifact-baseline.zh.md)

## Problem

The Codex Agent Driver source is outside the DeepSeek Harness Git checkout, while the running Web profile consumes an npm archive. A source directory, stale `lib/` files, or an old archive cannot by itself prove that a reviewed source tree produced the installed package and that the profile resolves the intended artifact.

The resident app-server runs inside the Web service's private `/tmp` mount. A live assembled test that creates its activation token below the host `/tmp` gives the daemon an unreadable path and turns an otherwise valid model request into an invalid activation credential.

## Decision

The baseline uses `/home/elsen_xu/deepseek-harness/.agents/research/codex-agent-driver-source-manifest.json` to record SHA-256 and byte counts for the external package's reviewed source roots (`src/`, `tests/`, and `scripts/`) plus its package and documentation inputs. `scripts/verify-baseline.mjs` requires that manifest to match, checks the package payload against the source package selection, verifies the archive hash and profile dependency, compares a fresh installation byte-for-byte, and checks the installed Host, Chat, native skills, identity, read-only TUI, and documented limitation markers.

The external build removes generated `lib/` before compiling with an explicit `DSH_CHECKOUT`; `prepack` rebuilds the Host and client artifacts and runs typecheck. A cutover archive is created in a new versioned `dist/` directory and installed into an isolated profile before verification.

The package's Codex version and schema digest are build provenance, not runtime minimums. Runtime admission discovers the installed executable and adjacent sidecar, validates the current schema, performs a fresh `initialize`/`initialized` handshake and behavior probes, and revalidates executable, sidecar, and resident identities before caching the attestation. An external Codex update therefore requires a controlled app-server restart and fresh admission, not a Driver package version change.

The resident assembled fixture creates its root under `XDG_RUNTIME_DIR`, or under the user's home cache when that variable is absent, so the daemon and test process share the workspace and activation-token path. This is a test-environment requirement; production token placement remains the explicitly configured DSH token directory.

The package README retains the intentional limits: native `web_search` is unsupported by the Bridge, the browser TUI is read-only, native collaboration controls are not projected, and Grok is a reserved blank adapter. The verifier is read-only with respect to running profiles and services; it does not restart Web or the shared Codex app-server.

## Alternatives considered

**Trust the installed archive or stale `lib/` tree.** Rejected because neither identifies the reviewed external source or proves that the profile resolves the archive produced by the current build.

**Create resident fixtures below host `/tmp`.** Rejected because `PrivateTmp=yes` hides that path from the shared daemon and invalidates command-backed activation credentials.

**Replace the live profile during baseline verification.** Rejected because a reproducible baseline can use an isolated installation while preserving the resident service, its shared app-server, and unrelated live Agents.

## Consequences

The external source remains outside Git and requires a reviewed manifest regeneration after every source, package, script, test, or README change. Each verification uses a new versioned archive directory and an isolated profile; installation into a live profile remains separately authorized. The baseline proves source, archive, installation, and profile identity, but it does not claim live Web behavior, writable TUI input, native web search, collaboration-mode UI, or Grok support.

## Verification

The reviewed manifest covers 62 files with tree SHA-256 `17d61bb5ad7d31459922797ce8fffdadd9038e65e599063ba275c7a4ec85f1b8`. `DSH_CHECKOUT=/home/elsen_xu/deepseek-harness npm run prepack` passes, and the full external suite reports 23 files with 143 passing and 2 skipped tests. The isolated `r22` archive at `dist/cutover-20260826-r22/dsh-external-dsh-codex-agent-driver-0.0.1.tgz` has SHA-256 `89d6bbbd0a0fab4693e822477003113611e307e9455ba58353a8236ad2ab2f9f`; `verify-baseline.mjs` verifies it against the isolated profile with installed-tree SHA-256 `1781707e2fbd909974eccc2fc6aee8ba7635dbad4f87fcf8fc688257023875c9`. The dedicated resident assembled command self-skips when the isolated runtime has no Codex daemon socket, so live installation and behavior remain separate verification.
