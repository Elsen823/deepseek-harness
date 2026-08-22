# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web boot kernel: `new AppWebEntry(el, seams?).run()` mounts the client through two stages. The module stage calls the Host-installed `window.__ModuleLoader__.create()` with `window.__DSH_BOOT__`, the shell's static modules, and any test transport override; the facade returns the constructed module system and parsed manifest after adopting deferred-bootstrap registrations. This package then prefetches the `immediately` tier. The plugin stage mounts the vendored Cordis Loader, injects that module system through the Loader's `internal` interface, and activates the paint-blocking chrome roster plus its transitive `dsh.client.inject` providers. Once that wave is ACTIVE, it hands the marked boot DOM to `ctx.uiRenderer.mount(el)`; the renderer hydrates that DOM before switching to the complete UI. Remaining graph rows activate after mount. Their failures are logged without replacing the mounted UI, and disposal waits for their outstanding imports. The Host owns the graph, deferred bootstrap scripts, and facade; AppWebEntry does not know the bootstrap package id or parse the wire format.

The boot page uses plain DOM and local CSS, so module and paint-blocking activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as blocking entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). The modules bundle caches its own materialized exports and provides the closed-over system when its ordinary graph entry activates; Cordis service waiting makes graph-row creation order independent from that activation.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it. A pre-injected page transport is the default ahead of it: when `globalThis.__DSH_TRANSPORT__` (the connection package's `ClientTransportHooks`) carries `loadBundle`, the module stage adopts it as the bundle transport and skips the immediate-tier HTTP prefetch — explicit `seams` still win.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The paint barrier is an explicit roster** — a failed blocking entry keeps the framework-free boot page visible with a per-entry report. Deferred rows do not block first paint; their failures are console diagnostics rather than boot-page state.
