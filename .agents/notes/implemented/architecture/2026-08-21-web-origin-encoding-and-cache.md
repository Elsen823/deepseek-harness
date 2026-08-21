# Agent Note: Origin content encoding, hashed-asset cache, and loopback-only source maps

Status: implemented

English | [中文](2026-08-21-web-origin-encoding-and-cache.zh.md)

## Problem

The Web GUI origin is a plaintext `node:http` server. Dist files and `/plugins/<id>/client.js` were sent uncompressed, without validators, and plugin bundles carried `Cache-Control: no-cache` even though their URLs already include a content `rev`. A composed page therefore transfers several megabytes of JavaScript on every visit, and opening DevTools can fetch an additional layer of `.map` files. High-RTT overlays (including Tailscale) multiply that cost by request count; replacing Node's already-nonblocking sockets with a Netty-style NIO server does not reduce bytes, round trips, or parse time.

HTTP/2 is not a product invariant of this origin ([WebSocket downlink carrier](2026-08-04-websocket-downlink-carrier.md)). A deployment may already terminate TLS and multiplex in front of `127.0.0.1`; the origin still has to emit compressible representations and cache headers those hops can forward.

## Decision

`dsh-host-webserver` exports `writeHttpBody` and `isDirectLoopback`. Asset routes in `dsh-host-frontend-static` and the client-modules plugin-bundle handler use them:

- gzip or Brotli when `Accept-Encoding` asks and the media type is text-like. The usual policy skips bodies below 256 bytes or a representation larger than identity; an explicitly lower-quality or forbidden identity representation overrides those two size optimizations. Every negotiated response carries `Vary: Accept-Encoding`, including binary identity and 406 responses.
- A normalized `/assets/` target with a hash-shaped filename and `/plugins/<id>/client.js?rev=…` whose `rev` exactly matches both the current graph row and the bytes just read send `Cache-Control: public, max-age=31536000, immutable`. Stale or malformed plugin revisions are 404. `index.html` (boot-manifest injection) and other unhashed files send `no-cache` plus an ETag so a matching `If-None-Match` returns 304. HMR still works because a content change produces a new `rev` or Vite hash and a new URL.
- Source maps (`.map` routes and trailing `sourceMappingURL` comments) are for a direct loopback client only: TCP peer loopback, `Host` a loopback name, and no `Forwarded`, `Via`, `X-Forwarded-*`, or `X-Real-Ip` headers. Reverse proxies that bind to 127.0.0.1, including Tailscale Serve, fail that check, so a remote DevTools session does not pull maps.

The paint barrier is the chrome roster in `partitionBootRoster`, not the full graph ([client plugin loading](2026-07-23-client-plugin-loading-model.md)).

## Alternatives considered

**Replace `node:http` with Netty-style NIO or an extra gateway process.** Node already uses libuv non-blocking I/O. An extra hop does not shrink payloads or HTML-driven request waterfalls and was rejected as the Page Load lever.

**Make HTTP/2 a product dependency of the origin.** Browsers do not speak h2c; TLS and certificates would become origin concerns. Deployments that want multiplexing put a TLS terminator in front. This change still helps a plaintext `:port` client via gzip and cache.

**Keep `no-cache` on every plugin bundle so a refresh always hits disk.** The `rev` query is already the cache buster ([client plugin loading](2026-07-23-client-plugin-loading-model.md)). Immutable caching of a `rev` URL does not hide a rebuild; a new graph row is a new URL. Index HTML continues to revalidate because it carries the live graph.

**Serve source maps to every client and rely on DevTools not to request them.** Chromium fetches `sourceMappingURL` whenever DevTools is open. Maps are larger than the scripts they describe; they are not session useful-work. Loopback keeps local debugging.

**Precompress `.gz`/`.br` at build time.** On-the-fly zlib is enough for a single-user origin and needs no extra artifacts. Precompression remains available if CPU on the origin becomes the bottleneck.

**Keep every graph row on the paint barrier.** Settings and third-party bundles then stay on the critical path. Chrome-first mount is the shipped paint barrier; this note owns bytes and cache, not that roster.

## Consequences

Repeat visits over a high-RTT path can reuse hashed scripts; a cold visit still transfers gzip/Brotli rather than raw source, and chrome can paint before deferred graph rows finish. Remote performance profiles no longer include maps. Route owners that buffer a complete body should call `writeHttpBody` instead of duplicating encoding. Streaming responses (SSE, WebSocket) are out of scope and must not be wrapped. A reverse proxy that strips forwarding headers and rewrites `Host` to `127.0.0.1` would be treated as loopback; Serve and Caddy do not do that.
