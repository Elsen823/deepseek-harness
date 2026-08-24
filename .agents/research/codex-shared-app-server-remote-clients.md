# Shared resident Codex app-server with remote and Orca clients

## Scope and source baseline

This report evaluates a Codex app-server that remains resident on the DSH host except during updates or explicit restarts and accepts DSH, Codex CLI/TUI, remote-control, SSH, and Orca-mediated clients.

Only primary sources are used:

- Codex 0.149.0 release [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0), peeled to [`758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`](https://github.com/openai/codex/commit/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0).
- Current upstream at research time [`c9b19deb09c1841ce7acc33ddb96276030936a29`](https://github.com/openai/codex/commit/c9b19deb09c1841ce7acc33ddb96276030936a29).
- Official OpenAI Codex documentation, principally the [app-server guide](https://developers.openai.com/codex/app-server) and [CLI reference](https://developers.openai.com/codex/cli/reference).
- Official Orca documentation for [SSH worktrees](https://www.onorca.dev/docs/ssh), [remote worktrees](https://www.onorca.dev/docs/recipes/remote-worktrees), and the [terminal](https://www.onorca.dev/docs/terminal), plus the installed Orca 1.4.186 CLI's own `status`, `terminal`, `environment`, and `serve` help.
- Current DSH source where the report discusses DSH-specific trust consequences.

The central daemon, transport, WebSocket authentication, remote client, Unix-socket, and remote-control sources are materially the same between the two Codex revisions. The official comparison shows only an unrelated credential-redaction/logging adjustment in the requested outgoing-message surface: [0.149.0…current comparison](https://github.com/openai/codex/compare/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0...c9b19deb09c1841ce7acc33ddb96276030936a29).

## Executive recommendation

Run **one resident app-server per OS identity and trust domain**, normally on the default Unix control socket. Let DSH connect locally. Let Orca and remote human workflows SSH to that host and run the host's Codex TUI against `unix://`; this keeps the Codex protocol, provider credentials, filesystem access, and DSH loopback services on the execution host and makes SSH plus the Unix account the security boundary.

Do not expose the raw app-server to untrusted or merely “authenticated” users. Its bearer-token authentication is endpoint-wide, not method-, model-, thread-, or tenant-scoped. The protocol includes full-access shell execution, absolute-path filesystem operations, configuration writes, authentication/account operations, and broad thread control. Multiple subscribers to one active thread also share approval and user-input authority: requests are sent to all subscribers and the first response wins. The implementation does not bind a server-request response to the connection that received the request.

For another host that must render its own local Codex TUI, use a loopback WebSocket listener through an SSH local forward and keep client/server versions matched. This requires supervising a WebSocket app-server instead of the stock daemon's Unix-only listener, or building a deliberate Unix-socket bridge. Both app-server and WebSocket transport are experimental/not production-supported, so the Unix-socket plus remote-terminal pattern is the lower-risk default.

## Resident daemon lifecycle

### Verified facts

`codex-app-server-daemon` is explicitly experimental. It is Unix-only and uses pidfiles, file locks, and Unix process primitives. Its documented commands are:

```text
codex app-server daemon start
codex app-server daemon restart
codex app-server daemon enable-remote-control
codex app-server daemon disable-remote-control
codex app-server daemon stop
codex app-server daemon version
codex app-server daemon bootstrap --remote-control
```

`start` is idempotent and returns only after the app-server answers the normal initialize handshake on its Unix control socket. `restart` stops the managed process and starts it again. `stop` first sends graceful termination, waits through a grace period, and later escalates if necessary. All mutating lifecycle operations are serialized per `CODEX_HOME` so concurrent start/restart/stop/bootstrap operations do not race ([0.149.0 daemon README](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-daemon/README.md), [daemon implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-daemon/src/lib.rs), [pid backend](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-daemon/src/backend/pid.rs)).

The daemon always launches the standalone managed binary under `CODEX_HOME/packages/standalone/current/codex`; it does not watch or launch an arbitrary `codex` from `PATH`. `bootstrap` requires an `install.sh` managed install. It starts app-server plus a detached updater that runs `install.sh` hourly, and after a changed binary is fetched it restarts app-server before replacing its own process image. The updater is not reboot-persistent; `bootstrap` must be run again after reboot. Plain `start` installs no updater and a running app-server remains on its current executable image until explicit restart ([daemon README](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-daemon/README.md)).

The daemon stores settings, pid records, updater pid, and the lifecycle lock under `CODEX_HOME/app-server-daemon/`. Lifecycle output is machine-readable JSON and reports the managed path/version, local CLI version, socket path, and running app-server version. The daemon can therefore detect and report a local-client/server version split, but does not negotiate compatibility ([daemon types and version probe](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-daemon/src/lib.rs#L56-L102)).

### Architecture implication

The stock daemon is suitable when DSH accepts Codex's standalone managed-install/update policy. If DSH must deliberately run an arbitrary host executable, DSH needs its own service supervisor and update/restart policy; calling the official daemon does not provide that behavior.

## Transports and remote connection forms

### stdio

`codex app-server` defaults to newline-delimited JSON over stdio. One stdio process represents one external connection and is not the transport for a separately resident shared daemon ([official protocol documentation](https://developers.openai.com/codex/app-server#protocol)).

### Unix control socket

`--listen unix://` listens on `$CODEX_HOME/app-server-control/app-server-control.sock`; `unix://PATH` chooses another path. The socket uses a WebSocket HTTP Upgrade and WebSocket frames over the Unix stream. The socket parent is private and the socket is set to mode `0600` on Unix. Startup refuses to replace a live socket and removes only a proven stale socket ([Unix-socket implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/unix_socket.rs)).

The acceptor spawns one connection task per accepted stream. This is the resident daemon's normal multi-client transport. Its authorization boundary is Unix filesystem/account access, not app-server bearer-token authentication.

### TCP WebSocket

`--listen ws://IP:PORT` accepts one JSON-RPC message per WebSocket text frame. It also serves `/readyz` and `/healthz`; requests with an HTTP `Origin` header are rejected with 403. Origin rejection is a browser-origin defense, not client authentication ([official transport documentation](https://developers.openai.com/codex/app-server#protocol), [WebSocket implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/websocket.rs)).

The source refuses to start an unauthenticated non-loopback listener. A loopback listener can run without app-server authentication; its banner recommends SSH port forwarding. OpenAI documents plain `ws://` only for localhost or an SSH-forwarded connection. App-server does not terminate TLS itself: the server listen option is `ws://`, while clients may use `wss://` through external TLS termination ([official remote TUI guidance](https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui), [listener source](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/websocket.rs)).

OpenAI explicitly states that the app-server command and WebSocket transport are experimental and are not supported for production workloads. The CLI reference adds that app-server is primarily for development/debugging and may change without notice ([app-server guide](https://developers.openai.com/codex/app-server), [CLI reference](https://developers.openai.com/codex/cli/reference#codex-app-server)).

### `app-server proxy`

`codex app-server proxy [--sock PATH]` opens exactly one connection to the running Unix control socket and copies bytes between that connection and stdin/stdout. The proxied bytes include the WebSocket HTTP Upgrade followed by WebSocket frames; it is not JSONL translation and it does not implement a client ([app-server README](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/README.md#protocol), [CLI definition and dispatch](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/main.rs#L728-L733)).

A custom program can therefore spawn `ssh host codex app-server proxy` and speak the full WebSocket handshake/protocol over SSH stdio. The stock `codex --remote` interface does not accept an `ssh://` or arbitrary command transport, so this pattern is for a custom app-server client, not a direct `codex --remote` invocation.

## `codex --remote` and SSH

### Verified facts

The interactive TUI accepts:

```text
codex --remote ws://host:port
codex --remote wss://host:port
codex --remote unix://
codex --remote unix://PATH
```

`--remote-auth-token-env ENV_VAR` reads a bearer token from the named environment variable. The client refuses to send a token to non-loopback plaintext `ws://`; a token requires `wss://` or loopback `ws://`. It places the token in `Authorization: Bearer …` during the WebSocket handshake ([official CLI reference](https://developers.openai.com/codex/cli/reference#codex-interactive), [0.149.0 remote client](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-client/src/remote.rs#L684-L718)).

`codex exec` explicitly rejects remote mode. Interactive start/resume/archive/unarchive/delete and `codex queue` support a remote endpoint; `queue` sends a message to an existing thread but does not itself provide a complete streamed automation result ([CLI dispatch](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/main.rs#L1144-L1160), [`queue` implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/queue_cmd.rs)).

### Practical SSH patterns — inference from supported transports

1. **Remote terminal, host-side TUI:** SSH to the app-server host and run the host Codex client against `unix://`, for example through an Orca SSH terminal. This needs no TCP listener and is the lowest-risk shared-daemon pattern.
2. **Local TUI through SSH forwarding:** run app-server on target-host loopback WebSocket, forward a local port with OpenSSH, then run the local TUI against local loopback. OpenAI recommends SSH forwarding but does not prescribe one exact `ssh -L` command.
3. **Custom protocol client through proxy:** spawn SSH with `codex app-server proxy` as the remote command and implement WebSocket framing plus Codex JSON-RPC locally.

The stock daemon hardcodes `--listen unix://`; it does not simultaneously expose its managed process on TCP WebSocket. A deployment wanting the second pattern must supervise a WebSocket-listening app-server instead of the stock daemon, or add a deliberate bridge to the Unix socket.

## WebSocket authentication

### Capability token

`--ws-auth capability-token` requires either a token file or a SHA-256 verifier. The client still presents the original token as `Authorization: Bearer`. App-server compares its SHA-256 digest in constant time. A token file is preferred; the hash option is only a verifier and does not give clients the raw token ([official authentication guidance](https://developers.openai.com/codex/app-server#protocol), [auth implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/auth.rs)).

### Signed bearer token

`--ws-auth signed-bearer-token` uses an HS256 shared secret of at least 32 bytes. Validation requires `exp`, supports optional `nbf`, and can enforce issuer, audience, and clock skew. The claims do not contain or enforce app-server method, thread, model, filesystem, or tenant scopes in the implementation examined ([auth implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/auth.rs#L306-L385)).

### Security conclusion

Both modes authenticate access to the entire endpoint. They do not authorize individual operations. Possession of a valid credential must be treated as equivalent to trusted interactive access under the app-server OS user.

## Remote-control lifecycle and pairing

Remote control is separate from direct local/SSH app-server access. `codex remote-control` without a subcommand runs an ephemeral foreground app-server with remote control. `start` enables remote control on the managed daemon, `stop` stops it, and `pair` requests a short-lived manual pairing code from an already-running daemon. Machine-readable pairing output includes the pairing code, manual code, environment ID, and expiry ([official CLI reference](https://developers.openai.com/codex/cli/reference#codex-remote-control), [remote-control CLI source](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/cli/src/remote_control_cmd.rs)).

Remote control requires a ChatGPT account identity and persisted SQLite enrollment. API-key authentication is rejected for remote-control enrollment. Enrollment obtains an expiring remote-control server token and uses it as a bearer credential for the remote-control service/WebSocket. Pairing posts with that token and verifies the returned server/environment identity ([remote-control enrollment](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/remote_control/enroll.rs), [remote-control auth](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-transport/src/transport/remote_control/auth.rs)).

Remote-control clients become ordinary app-server connections after transport mapping. It is intended for managed desktop/mobile and SSH remote-management workflows. The official CLI reference says it is not a replacement for `app-server --listen` when building a local protocol client.

## Multi-client and multi-thread behavior

### Verified connection behavior

Each accepted stdio, Unix, WebSocket, or remote-control stream receives a `ConnectionId` and its own initialize state and notification opt-outs. The transport keeps a connection map and can broadcast global notifications or target one connection. Slow WebSocket clients whose outbound queue fills are disconnected ([transport state and dispatch](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/transport.rs)).

A connection that starts or resumes a thread is automatically subscribed. Thread state maintains a set of subscribed connection IDs and a reverse map from connections to threads. Multiple connections may subscribe to the same thread; disconnect and `thread/unsubscribe` remove only that connection. `thread/read` reads stored data without subscribing. When the final subscriber leaves, a thread can remain loaded until the documented 30-minute no-subscriber inactivity grace expires ([official subscription behavior](https://developers.openai.com/codex/app-server#unsubscribe-from-a-loaded-thread), [thread-state implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/thread_state.rs#L478-L617)).

Requests carrying the same thread serialization key are processed in order, while different thread keys can drain independently. The process is therefore designed to host multiple active threads, not one global conversation ([request serialization](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/request_serialization.rs)).

### Single-writer rules

The local thread store uses a per-thread filesystem writer lock. A competing process trying to acquire a live thread writer gets a conflict stating that the thread already has an active writer; releasing the live writer releases/removes the lock. This prevents two app-server processes from appending concurrently to the same thread. It does not prevent separate processes from using different threads in the same `CODEX_HOME`, and it is not a tenant-isolation mechanism ([writer-lock implementation](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/thread-store/src/local/writer_lock.rs)).

Several clients sharing one app-server are safer than several app-server processes sharing one `CODEX_HOME`: same-thread clients reuse the process's one live thread/writer, while cross-process access relies on filesystem/SQLite contention controls. The official SQLite source includes mixed-version accommodations, but OpenAI does not present concurrent independent app-server processes as an isolation or production-multiplexing contract.

## Approval and user-input routing

### Verified facts

For a loaded thread, app-server snapshots the current subscriber connection IDs into a thread-scoped sender. Server requests—including command/file/permission approvals and `request_user_input`—are cloned to all those subscribers. When another client resumes/attaches to the thread, pending requests are replayed to it ([thread-scoped sender](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/outgoing_message.rs#L129-L170), [request fanout and replay](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/outgoing_message.rs#L275-L380)).

There is one callback per server request ID. The first client response removes that callback and resolves the request; later responses find no callback. The response-processing entry point receives only the JSON-RPC response ID/result and does not preserve or validate the responding `ConnectionId` ([response resolution](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/outgoing_message.rs#L383-L421), [connection identity discarded](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/src/message_processor.rs#L816-L826)).

### Consequences — inference

- There is no designated approval owner or input owner for a shared active thread; first response wins.
- A DSH unattended client that declines approvals can race a human TUI that intends to approve, and vice versa.
- A connected client that can observe or predict a live sequential request ID may be able to race a response even when it was not a thread subscriber, because response resolution does not verify the originating connection.
- Use one approval-capable client per active thread. Additional clients should use `thread/read` without subscribing, or should be trusted to share response authority.

## Version mismatch between remote TUI and server

The initialize response exposes the app-server `userAgent`. The remote TUI extracts and stores the server version for status display; `/status` shows the remote endpoint and server version. The daemon also reports local CLI, managed binary, and running server versions ([remote-client initialization](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-client/src/remote.rs#L798-L940), [official `/status` behavior](https://developers.openai.com/codex/cli/reference#inspect-the-session-with-status)).

No general client/server version comparison or compatibility negotiation was found. Generated protocol schemas are exact-version artifacts. The remote client rejects server requests it does not understand with `-32601` and drops notifications it cannot convert. A mismatched client can therefore connect but lose features, fail an approval/input request, or omit notifications rather than being rejected up front ([remote-client dispatch](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server-client/src/remote.rs), [version-specific schemas](https://developers.openai.com/codex/app-server#message-schema)).

Prefer running the client binary on the server host, from the same managed installation as the daemon. If a local client connects through an SSH tunnel, compare its version with `codex app-server daemon version` and permit only tested version pairs.

## Orca: realistic integration without inventing a protocol

### Verified Orca capabilities

Official Orca documentation says SSH worktrees create the worktree on the remote host, run agents remotely through SSH, synchronize files, and preserve/reconnect remote terminal sessions across desktop disconnects ([SSH worktrees](https://www.onorca.dev/docs/ssh), [remote worktree recipe](https://www.onorca.dev/docs/recipes/remote-worktrees)). Orca's terminal is an xterm.js terminal designed for AI-agent workflows ([terminal docs](https://www.onorca.dev/docs/terminal)).

The installed Orca 1.4.186 CLI reports a ready runtime and exposes:

- `orca terminal create --worktree … --command …`;
- `orca terminal send`;
- `orca terminal read`;
- `orca terminal wait --for exit|tui-idle`;
- `orca serve` and `orca environment add` for paired remote Orca runtimes.

Its reported capability list contains terminal, SSH/environment, orchestration, and agent-session capabilities, but no Codex app-server protocol client capability. This is a negative finding for the inspected version, not a permanent product guarantee.

### Recommended Orca patterns

1. **Preferred:** use an Orca SSH worktree/terminal and run the target host's `codex --remote unix://`. Orca manages the terminal; Codex remains the protocol client.
2. **For simple existing-thread injection:** an Orca SSH command can run the host `codex --remote unix:// queue --thread … --message …`. This queues input but is not a complete programmatic result-stream interface.
3. **Local Codex TUI:** run an SSH tunnel in one Orca terminal and a local `codex --remote ws://127.0.0.1:LOCAL_PORT` TUI in another. Codex, not Orca, is the app-server client.
4. **Paired Orca remote runtime:** run `orca serve` on the target and connect it as an Orca environment, then launch Codex in a terminal there. Orca's pairing protocol remains separate from Codex remote control and app-server.
5. **Direct Orca app-server client:** this would be a new custom integration. It must implement exact-version JSON-RPC, WebSocket framing, initialize, thread subscriptions, event rendering, server-request replies, reconnection/replay, authentication, version gating, and explicit approval arbitration. No such direct client was found in the inspected official Orca CLI/runtime surface.

## Risks to the DSH loopback Responses proxy and DSH-added models

### Verified underlying authority

App-server is not a narrow chat API. Its documented surface includes:

- `thread/shellCommand`, which explicitly runs outside the sandbox with full host access;
- absolute-path `fs/readFile`, `fs/writeFile`, `fs/remove`, `fs/copy`, and related methods;
- configuration reads and writes to the user's `config.toml`;
- account login/logout and account/rate-limit operations;
- model/provider selection on thread start/resume;
- experimental process and terminal controls.

See the [official app-server API overview](https://developers.openai.com/codex/app-server#api-overview), [`thread/shellCommand`](https://developers.openai.com/codex/app-server#run-a-thread-shell-command), and [config/auth APIs](https://developers.openai.com/codex/app-server#auth-endpoints).

Current DSH's Codex provider documentation says native `HOME`/`CODEX_HOME` configuration, authentication, model, provider, MCP, hook, skill, and account settings remain authoritative to the spawned Codex process ([DSH Codex provider README](../../packages/subagent/subagent-codex/README.md#configuration)). Codex provider configuration supports a custom `base_url`, Responses wire protocol, and credentials sourced from host environment variables ([official Codex config reference](https://developers.openai.com/codex/config-reference)).

### Security assessment — inference

If the shared app-server's Codex configuration exposes a DSH-added provider that points to a target-host loopback Responses proxy, a remote app-server client does not need direct network reachability to that proxy. It can ask the host app-server to select that provider/model; the host Codex process then calls the loopback proxy using host configuration and credentials. App-server becomes a confused-deputy bridge across the loopback boundary.

Consequences include:

- use of DSH-only/custom models and shared model quota by external clients;
- use of host-stored provider credentials without revealing the raw token to the normal client;
- access to model outputs, threads, and workspace side effects under the shared OS identity;
- possible credential or configuration exposure through full-access shell, filesystem, logs, or config APIs;
- provider-secret exfiltration risk if a privileged client can rewrite a custom provider endpoint and cause Codex to authenticate to it;
- direct reachability from model-generated commands to other host-loopback services;
- logout/config changes affecting every client in the shared `CODEX_HOME`.

Loopback binding protects the proxy from direct remote TCP access, but not from a remotely controlled process already running on the host. Codex WebSocket bearer authentication proves endpoint access only; it supplies no provider/model quota boundary or per-client authorization.

## Recommended architecture

### Trust boundary

- One resident app-server, one `CODEX_HOME`, one OS identity, and one provider credential/quota set **per mutually trusted client group**.
- Never share one app-server across tenants or users who should not share filesystem authority, thread visibility/control, models, spend, configuration, or account state.
- If external workflows should have narrower models or quota, give them a separate OS user, `CODEX_HOME`, app-server, and provider credential. Do not rely on `clientInfo.name`, bearer-token identity, thread IDs, or approval policy as tenant isolation.

### Local and SSH topology

- Run the managed daemon on its owner-only Unix socket when Codex's managed-install lifecycle is acceptable.
- Connect DSH directly to that Unix socket or through a local `app-server proxy` subprocess.
- For Orca/human SSH access, run the target host's matching Codex TUI with `--remote unix://` inside an Orca SSH terminal.
- Keep remote observers on `thread/read` where possible; do not resume/subscribe them to an active DSH-owned thread unless they are allowed to answer its approvals and user-input requests.
- Use a separate supervised loopback WebSocket app-server only when local rendering on another host is required. Cross it through SSH, enable a bearer token even on loopback as defense in depth, and version-gate the remote TUI.
- Do not bind app-server to LAN/WAN. If direct remote WebSocket is unavoidable, require external TLS, strong short-lived credentials, network allowlists, and a trust model equivalent to SSH login to the app-server OS account.

### Thread ownership

- Assign one orchestration/approval owner per active thread.
- Do not attach both a DSH unattended approval responder and a human TUI to the same active thread unless first-response-wins behavior is explicitly accepted.
- Use different threads for independent clients. A shared process can execute different thread queues concurrently.
- Keep one app-server process as the writer owner. Do not start independent app-servers on the same active thread.

### DSH proxy/model controls

- Require authentication and explicit tenant/model authorization at the DSH Responses proxy itself; do not trust source loopback as authorization.
- Issue distinct provider credentials and quotas per app-server trust domain.
- Do not expose DSH-internal providers in the `CODEX_HOME` used by external clients unless their use is intended.
- If DSH builds a direct client, enforce a local allowlist of app-server methods and reject shell, filesystem, config-write, account-write, login/logout, process, and destructive thread methods unless explicitly required. This protects DSH from accidental calls but cannot constrain other clients connected directly to the same raw app-server.
- Audit `clientInfo`, thread origin, provider/model selection, config changes, approvals, and shell/filesystem operations; do not treat those logs as authorization.

## Final assessment

A shared resident app-server is technically designed for multiple connections and multiple threads, and the stock Unix daemon provides the desired remain-resident/update-restart lifecycle on Unix. It is reasonable for several mutually trusted DSH/Orca/Codex clients to share one process and `CODEX_HOME`.

It is not safe as a multi-tenant or least-privilege service. The raw protocol grants host-level capabilities, one shared account/config/model surface, and first-responder authority over approvals/input. The production-shaped architecture is therefore **resident Unix daemon + SSH/Orca remote terminals + matching host Codex TUI + one trust domain**, with separate daemon/home/OS identity/provider credentials for any external client group that should not inherit DSH's loopback proxy, custom models, filesystem, account, or spend authority.
