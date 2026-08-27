# @deepseek-ai/dsh-client-ui-claude-agent-driver

English | [中文](README.zh.md)

The browser half of the Claude Code Agent Driver. It contributes a Web Settings section through the shared `settings.section` slot and reads the Host's generic `session.drivers` catalog; no Claude-specific service or branch is added to client runtime or core packages.

The section reports whether the `claude` Driver is available for new Sessions and states the native ownership rules: Claude Code keeps its instructions, skills, tools, hooks, approvals, and execution loop. Provider, model, and effort incompatibilities are rejected by the host adapter before a turn. The reserved Grok id is displayed as a blank adapter rather than presented as an executable provider.

The package does not edit Claude settings or credentials. Claude account state, CLI authentication, native permissions, and native activity remain Host-owned. The entry is read-only management metadata and disappears with the browser plugin fiber.

The same opt-in package contributes a `Driver Activity` conversation tab through the agent-neutral `conversationEvents`, `conversationViews`, and `conversation.view` registrations. It folds bounded `agent-driver/activity` facts into a read-only list that identifies the DSH Session, Driver, native conversation, runtime status, and native activity; Chat remains the only input surface.

## Opt-in Web composition

Add the browser row through a dedicated profile or test/example overlay together with the host provider row. Keep it out of `packages/bundle/web-app/cordis.patch.yml` so shipped Web defaults do not load the optional Claude package.

```yaml
- insert:
    - id: ui-claude-agent-driver
      name: '@deepseek-ai/dsh-client-ui-claude-agent-driver'
```

## Model Experience

### Read-only activity projection

#### What the model sees

This package adds no prompt, tool schema, or model-visible instruction. It renders the logged `agent-driver/activity` facts, Driver identity, native conversation identity, and runtime attention state for a human operator.

#### Token effect

The browser projection sends no new model request and consumes no model tokens; its `conversation.view` output is a UI read model of durable Session events.

#### KV Cache effect

Loading, refreshing, or switching the tab does not alter a native conversation or its cache; only Host-side Chat input can advance the native turn.

## Known Limitations and Deferred Work

- **Host catalog only** — the browser sees active Driver names, not provider credentials or native settings files.
- **Read-only management and Activity** — changing Claude permission, model aliases, hooks, and account state remains a native Claude configuration task; the Activity tab exposes bounded durable summaries rather than raw native protocol payloads or controls.
- **Real attention visualization is a manual browser gate** — ordinary offline coverage uses `permissionMode: dontAsk` and supplies no native interaction callbacks, so provider tests cover attention counts while a clean real-model run must show a pending native interaction in the UI.
