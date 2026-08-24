# @deepseek-ai/dsh-todo

English | [中文](README.zh.md)

Portable Service Provider for the `todos` SessionProjection. It derives the current whole Checklist from core Session events and has no model tool, mutation controller, or dependency on `ctx.tools`.

## Projection semantics

The provider registers the sole `todos` unit on `ctx.sessionProjections`. Its empty value is `null`; each `todo/write` replaces the value with that event's entire `TodoItem[]`; `turn/start` clears it to `null`; `turn/end` and unrelated events preserve the same state reference. The finished Checklist therefore remains visible until the next turn starts.

The wire view is the state itself. `stateVersion` remains `2` because package relocation changes neither serialized state nor fold semantics. The package owns the `SessionProjectionMap.todos` and `SessionProjectionStateMap.todos` declarations plus the Zod schemas that validate cached state and wire values.

Registration is effect-scoped: unloading removes the projection and releases producer ownership. A second provider mount against the same registry fails instead of sharing or replacing the producer.

## Composition

```yaml
- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: todo
  name: '@deepseek-ai/dsh-todo'
```

`@deepseek-ai/dsh-tool-todo` is an optional Consumer. Mount it separately only when a model should mutate the Checklist through `todo_write`.

## Model Experience

None, as the provider only folds already-logged Session events and registers no prompt section, tool schema, model message, stream middleware, or tool result.

#### KV Cache effect

None; the provider never assembles or sends a model request.

## Known Limitations and Deferred Work

- **Whole-list events only** — the fold depends on each `todo/write` carrying the complete replacement list; it does not merge item-level deltas.
- **Turn-scoped visibility** — a Checklist is cleared by the next `turn/start`, including a turn that closes without a model step.
