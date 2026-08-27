# Agent Note: Claude Agent Driver native ownership

Status: implemented

English | [中文](2026-08-25-claude-agent-driver-native-ownership.zh.md)

## Problem

The Agent Driver registry must prove that a second execution implementation can own a durable Session without adding product-specific branches to core or making DSH responsible for another CLI's native policy.

## Decision

`@deepseek-ai/dsh-claude-agent-driver` is an optional provider package outside core. It registers the Claude Driver and an opaque `claude-code-settings` contribution through the shared `AgentRegistry` seam; core stores and disposes the contribution without interpreting Claude fields, and the reserved Grok id remains a blank adapter.

Claude Code owns instructions, skills, tools, hooks, approvals, permissions, and execution. The provider sends direct text Chat input to the Claude Agent SDK, maps representable DSH provider/model/effort selections to native values, and throws `ClaudeModelSelectionError` with the rejected selection and explicit incompatibility reason for unsupported values. Generic activation, model-request, attempt, activity, checkpoint, assistant-message, and turn events retain the reconstructable DSH timeline without copying raw native protocol payloads.

The provider opens Claude's text-prompt Query mode one native turn at a time, so it does not use SDK `streamInput()`. `steer()` explicitly queues a direct user message for the next DSH/native turn; an active native query continues uninterrupted, and one queued steering message is delivered once without remaining in the `next-step` inbox.

The provider retains Claude's branded native conversation id as Driver provenance. Resume passes that id to the SDK's `resume` option; `observeClaudeSession()` derives identity, activity count, and cold/active status from the Session log without activation or query. The model-request event records the exact direct prompt and serializable native options before `query()` is called and names native instruction, skill, tool, and hook inputs that the SDK does not expose. Optional native approval, elicitation, and user-dialog callbacks contribute runtime attention counts without changing their native decisions. Host runtime status carries the immutable Claude Driver id, binary Agent activity, availability, attention counts, and native activation detail.

For lifecycle-derived conversation identity, the client model-selection projection reads the generic `provenance.nativeConversationId` field on `agent-driver/activation` and `agent-driver/checkpoint` events. A first native turn therefore becomes identifiable when its checkpoint is recorded without a Claude-specific conversation field in the Driver payload, while Selected, Effective, Native, DSH Session, status, and read-only Activity remain separate projections.

The browser package contributes a read-only settings and management entry plus a `Driver Activity` conversation tab through the agent-neutral conversation registries and view slot. Claude provider and UI rows load through a dedicated profile or test/example overlay; the shipped Web bundle does not load either optional package. The offline overlay uses `permissionMode: dontAsk` and supplies no native interaction callbacks, so real attention visualization remains a manual check; focused callback tests cover the bridge without adding synthetic production attention hooks.

## Alternatives considered

**Branch inside core or `dsh-agent-loop`.** This would make the default execution package own Claude protocol and process policy. The named provider keeps core agent-neutral and lets each Driver own its native lifecycle.

**Inject DSH prompt, tool, or approval context into Claude.** This would create two competing policy owners and make native Claude behavior depend on DSH's prompt vocabulary. Direct Chat remains the only DSH-authored model input while Claude keeps its native capabilities.

**Ship Claude in the Web default.** This would add an optional SDK and native provider to every keyless Web deployment. The explicit overlay keeps the default dependency and composition closure provider-neutral.

**Infer unsupported selections or native identity.** Silent fallback would change the requested route or claim a conversation continuity the provider cannot prove. The mapper rejects incompatibility explicitly, and observation reads only logged provenance.

**Claim complete reconstruction of native prompt internals.** The Claude SDK does not expose its final instructions, skills, tools, or hook-expanded prompt. The provider records the exact direct prompt and effective adapter options, explicitly names those unavailable inputs, and leaves their ownership with Claude.

**Use SDK streaming input for DSH steering.** The provider's text-prompt Query mode does not expose a reliable native step boundary for DSH steering. Queueing steering at the next native turn keeps Claude's execution owner intact and gives the DSH inbox one durable delivery boundary.

## Consequences

Claude settings consumers can evolve their own opaque contribution without widening core. DSH can render final native answers and bounded activity summaries in Chat and Driver Activity while native instructions, tools, approvals, and execution remain outside the DSH transcript. Non-text Chat blocks, complete native prompt reconstruction, and raw protocol activity remain unsupported and are reported as package limitations; optional SDK interaction callbacks expose pending attention without changing native decisions.

## Verification

Provider tests cover registration disposal, direct Chat, exact pre-query request snapshots, native identity and activity, explicit model incompatibility, cancellation, maintenance quiescence, initiator scope, native interaction attention, resume options, and active-query steering delivery. The assembled Web snapshot loads the optional UI only through the test overlay. The keyless Chromium fixture binds `driverId: claude`, proves the first-turn missing-id to checkpoint-identity transition, renders Selected, Effective, Native, and DSH Session identities plus status and the read-only Driver Activity tab, retains activity and checkpoint provenance, observes the live Session without appending events, and checks resumed native identity and request continuity. The clean real-model GIF and real attention visualization remain manual evidence.
