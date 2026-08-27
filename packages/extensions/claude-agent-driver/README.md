# @deepseek-ai/dsh-claude-agent-driver

English | [中文](README.zh.md)

This package provides a Claude Code Agent Driver for one durable DeepSeek Harness Session. It is an optional host provider: loading it registers the `claude` Driver and its opaque `claude-code-settings` contribution, but it starts no native process until a Session bound to that Driver receives direct Chat input.

## Native ownership

The adapter calls `@anthropic-ai/claude-agent-sdk` `query()` with the Session workspace and the selected native model and effort. Claude Code remains the authority for instructions, skills, tools, hooks, approvals, permissions, and execution; the adapter does not prepend DSH prompt text, translate DSH tools into Claude tools, or replace native policy callbacks. `inject()` therefore accepts no model-visible context, while `followup()` and `steer()` accept direct user messages with text blocks.

Because this adapter opens Claude's text-prompt Query mode for one native turn, `steer()` cannot use the SDK's `streamInput()` boundary. It explicitly queues a direct steering message for the next DSH/native turn, so an active native query is never interrupted and the steering message is delivered once at the following turn.

The native query receives the configured `permissionMode` and optional executable path. Settings, account state, CLI authentication, native tool execution, and hook behavior remain Claude-owned. Optional SDK approval, elicitation, and user-dialog callbacks are wrapped only to contribute process-local runtime attention counts; their return values remain the native decision. A query result becomes the DSH assistant message; native tool and reasoning observations become generic `agent-driver/activity` facts without copying native protocol payloads into the DSH prompt.

## Model selection

`ClaudeModelRouteMapper` validates the selected DSH provider, model, and reasoning effort before a turn. Provider ids must match `provider`; Claude model aliases are resolved through `modelAliases`, and an optional `supportedModels` list constrains the accepted DSH and native ids. Unsupported providers, model ids, or effort names throw `ClaudeModelSelectionError` with the rejected selection and an explicit incompatibility reason. Representable selections are passed to Claude unchanged apart from the declared alias.

## Session lifecycle and observation

Each activation records the generic activation, request, attempt, activity, checkpoint, turn, and assistant-message events required to reconstruct the DSH-visible request timeline. The model-request event includes the exact direct prompt and serializable native options before `query()` is called. Claude's `system/init` session id is retained as branded native conversation identity; the next activation uses SDK `resume` with that identity. The client runtime reads the generic `nativeConversationId` from activation and checkpoint provenance, so a first-turn identity appears when the checkpoint first records it without a Claude-specific conversation field in the Driver payload. `observeClaudeSession(session)` is read-only: it derives identity, activity count, and cold/active status from durable events without activating Claude or issuing a query. Cancellation aborts and closes the native query, and `whenIdle()` waits for replacement work to converge before resolving.

The Driver contributes its settings and management metadata through `AgentRegistry.registerDriverContribution()`. Core stores that value opaquely and removes it with the Driver generation, so settings consumers own their vocabulary and core has no Claude branch. The reserved Grok id remains an empty adapter; DSH-specific permission, plan, goal, and tool consumers continue to decide whether they support alternate Drivers.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `anthropic` | DSH provider id represented by Claude Code. |
| `model` | `claude-sonnet-4-6` | Default native Claude model for a blank Session. |
| `modelAliases` | `{}` | DSH model ids mapped to native Claude ids. |
| `supportedModels` | `[]` | Optional exact model allowlist; empty uses Claude id and alias recognition. |
| `supportedEfforts` | `low, medium, high, xhigh, max` | Native effort values accepted by this deployment. |
| `permissionMode` | `dontAsk` | Native Claude permission mode supplied to each query. |
| `cliPath` | unset | Optional explicit Claude Code executable path. |

## Opt-in Profile composition

Add the provider row to a profile patch that explicitly installs Claude Code. Keep this row out of the shipped Web bundle so the default Web composition remains keyless and provider-neutral.

```yaml
- insert:
    - id: claude-agent-driver
      name: '@deepseek-ai/dsh-claude-agent-driver'
```

## Model Experience

### Chat input and output

#### What the model sees

The native Claude Code process sees the direct user text passed to `query()` and its own configured instructions, skills, tools, hooks, approvals, and execution policy. DSH does not add a second system prompt or inject DSH tool schemas into the native request. The DSH transcript receives the final native answer and generic activity rows for observation.

#### Token effect

The native process owns its context and token accounting. DSH records reported input and output usage on the model-attempt and assistant-message events when Claude provides both values; it does not re-tokenize native instructions, skills, tools, or hook payloads.

#### KV Cache effect

Native continuation uses Claude's conversation identity and native persistence. DSH model selection changes are logged before the next request, so a changed provider, model, or effort begins a new effective route while previously recorded messages remain immutable.

## Known Limitations and Deferred Work

- **Direct text only** — image, tool-result, and other non-text Chat blocks are rejected with an explicit input error.
- **Native prompt internals remain opaque** — the Claude SDK does not expose the final instructions, skills, tools, or hook-expanded prompt, so the durable request records the exact direct prompt and effective adapter options and names those omitted native inputs instead of claiming full native reconstruction. DSH does not synthesize approval or user-input decisions; when a host supplies SDK callbacks, runtime attention counts cover their pending intervals while Claude retains the decision.
- **Native activity is summarized** — the durable timeline records identity-safe activity titles and bounded data, not raw Claude protocol messages, credentials, stderr, or full tool arguments.
- **A live native conversation is required for resume** — when its native identity is unavailable, the Session is observed as cold until a fresh query establishes one.
