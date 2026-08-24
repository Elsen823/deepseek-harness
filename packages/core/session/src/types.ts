import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  AssistantMessage,
  CallId,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  Message,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue } from './json.ts'

// The lossless-JSON payload type belongs to this client-safe face too: a wire
// contract carrying JSON data must not import the root entry, which merges
// `ctx.sessions` (a Host-only SessionStore) into every consumer's program.
export type { JsonValue } from './json.ts'

/** Identifies the agent driver bound to one session lifecycle. */
export type AgentDriverId = Branded<'AgentDriverId'>

/**
 * Brand a string as an {@link AgentDriverId}.
 * @param id - the raw agent driver id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function AgentDriverId(id: string): AgentDriverId {
  return id as AgentDriverId
}

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function SessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * The on-disk session format version, stamped into every newly-written {@link SessionHeader}
 * and enforced by every persistence backend on load. The single source of truth for the
 * version — write sites and the load-time check all read it.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided.
 *
 * The version is a single monotonic integer with no major/minor split. Whether
 * a bump is needed is decided by what the WRITER emits, never by what a newer
 * reader can accept: bump exactly when an older runtime could no longer handle
 * a new log with full semantic correctness ("parses without error" is not
 * correctness — silently skipping content that shapes reconstruction is a
 * wrong read). Only structural changes reach that bar: the header shape, the
 * {@link SessionEvent} envelope, core event semantics, or the surface
 * mechanism (the {@link SurfaceEventType} set and {@link SurfaceOp} variants).
 * Adding an ordinary event type does not bump — the per-event
 * {@link SessionEvent.ignorable} guard covers vocabulary growth instead. When
 * in doubt, bump: a near-identity upgrade step is almost free, a missed bump
 * makes older runtimes read new logs wrong silently. The full mechanism
 * (upgrade-step chain, in-memory view conversion, migrate-on-continue) is
 * recorded in the session-log-version-mechanism Agent Note
 * (`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`).
 */
export const SESSION_FORMAT_VERSION = 0

/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
export interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** Agent driver that owns creation, resume, and continuation of this session. */
  readonly driverId: AgentDriverId
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
}

/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
export interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta: {
    /** Agent driver that owns the new session lifecycle. */
    readonly driverId: AgentDriverId
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}

/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
export interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[]
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence'
}

/** Inputs accepted while constructing an unpublished Session. */
export type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly seedSource?: undefined })
  | RestoredSessionOptions

/** Why an active agent driver was cancelled. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** Durable cancellation cause, including imports whose original coarse record carried no cause. */
export type TurnEndCancelCause = AgentCancelCause | { readonly kind: 'legacy' }

/**
 * Why a turn ended. Merge-extensible sum type.
 */
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }

  blocked: { kind: 'blocked' }
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code: 'UNKNOWN' }`
   * flattened from any other error.
   */
  error: { kind: 'error'; error: LlmFailure }
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: { kind: 'interrupted' }
}

/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
export interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
}

/** Registration-bound metadata for one resolved model route. */
export interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  provider: string
  /** Provider-owned model id the metadata belongs to. */
  model: string
  /** Maximum combined request and response context in tokens, when advertised. */
  contextWindow?: number
}

/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header.
 */
export type RequestHeaderReason = 'initial' | 'resume' | 'change'

/** Identifies one live ownership period of an Agent Driver. */
export type AgentDriverActivationId = Branded<'AgentDriverActivationId'>

/**
 * Brand a string as an {@link AgentDriverActivationId}.
 * @param id - raw activation id.
 * @returns the branded id.
 */
export function AgentDriverActivationId(id: string): AgentDriverActivationId {
  return id as AgentDriverActivationId
}

/** Identifies one exact model-visible request captured by an Agent Driver. */
export type AgentDriverModelRequestId = Branded<'AgentDriverModelRequestId'>

/**
 * Brand a string as an {@link AgentDriverModelRequestId}.
 * @param id - raw model-request id.
 * @returns the branded id.
 */
export function AgentDriverModelRequestId(id: string): AgentDriverModelRequestId {
  return id as AgentDriverModelRequestId
}

/** Identifies one execution attempt of a captured model request. */
export type AgentDriverModelAttemptId = Branded<'AgentDriverModelAttemptId'>

/**
 * Brand a string as an {@link AgentDriverModelAttemptId}.
 * @param id - raw model-attempt id.
 * @returns the branded id.
 */
export function AgentDriverModelAttemptId(id: string): AgentDriverModelAttemptId {
  return id as AgentDriverModelAttemptId
}

/** Identifies one semantic Agent Driver activity item or group. */
export type AgentDriverActivityId = Branded<'AgentDriverActivityId'>

/**
 * Brand a string as an {@link AgentDriverActivityId}.
 * @param id - raw activity id.
 * @returns the branded id.
 */
export function AgentDriverActivityId(id: string): AgentDriverActivityId {
  return id as AgentDriverActivityId
}

/** Identifies one durable Agent Driver checkpoint. */
export type AgentDriverCheckpointId = Branded<'AgentDriverCheckpointId'>

/**
 * Brand a string as an {@link AgentDriverCheckpointId}.
 * @param id - raw checkpoint id.
 * @returns the branded id.
 */
export function AgentDriverCheckpointId(id: string): AgentDriverCheckpointId {
  return id as AgentDriverCheckpointId
}

/** Identifies one Proposed Plan document across lifecycle snapshots. */
export type AgentDriverProposedPlanId = Branded<'AgentDriverProposedPlanId'>

/**
 * Brand a string as an {@link AgentDriverProposedPlanId}.
 * @param id - raw Proposed Plan id.
 * @returns the branded id.
 */
export function AgentDriverProposedPlanId(id: string): AgentDriverProposedPlanId {
  return id as AgentDriverProposedPlanId
}

/**
 * Driver-owned detail nested below a statically known outer event. Consumers
 * that do not recognize `kind` retain `payload` and fall back to the event's
 * core fields instead of discarding or reinterpreting the durable fact.
 */
export interface AgentDriverDetail {
  /** Driver-specific discriminant. Unknown values are valid. */
  readonly kind: string
  /** Lossless-JSON data interpreted only by the owning Driver integration. */
  readonly payload?: JsonValue
}

/** Provider-credential-free failure facts shared by activation, attempts, and checkpoints. */
export interface AgentDriverFailure {
  /** Stable machine-routing code. */
  readonly code: string
  /** Human-readable account safe to retain in the Session log. */
  readonly message: string
  /** Whether the producer considered the failure retryable. */
  readonly retryable?: boolean
  /** Additional credential-free Driver detail. */
  readonly detail?: AgentDriverDetail
}

/** Provenance of an activation or checkpoint without exposing provider credentials. */
export interface AgentDriverProvenance {
  /** How the durable Driver state came into use. */
  readonly kind: 'created' | 'resumed' | 'reconstructed' | 'imported'
  /** Prior activation when this fact continues or reconstructs one. */
  readonly sourceActivationId?: AgentDriverActivationId
  /** Opaque native conversation identity, when safe to persist. */
  readonly nativeConversationId?: string
  /** Driver-specific provenance fields with unknown-kind fallback. */
  readonly detail?: AgentDriverDetail
}

/** Compatibility facts captured when native Driver state is opened or checkpointed. */
export interface AgentDriverCompatibility {
  /** Driver runtime/version that produced or consumed the state. */
  readonly runtime: string
  /** Driver-native durable format or schema identifier, when known. */
  readonly format?: string
  /** Result of comparing this runtime with prior native state. */
  readonly status: 'same' | 'certified' | 'reconstructed' | 'incompatible' | 'unknown'
  /** Prior runtime/version, when a transition was evaluated. */
  readonly previousRuntime?: string
  /** Driver-specific compatibility facts with unknown-kind fallback. */
  readonly detail?: AgentDriverDetail
}

/** An explicit break in native Driver continuity retained by the DSH Session. */
export interface AgentDriverDiscontinuity {
  /** Stable generic classification. */
  readonly kind: 'conversation' | 'history' | 'runtime' | 'checkpoint'
  /** Human-readable consequence for the retained Session. */
  readonly message: string
  /** Driver-specific discontinuity facts with unknown-kind fallback. */
  readonly detail?: AgentDriverDetail
}

/** One whole lifecycle snapshot for a Driver activation. */
export interface AgentDriverActivationSnapshot {
  readonly owner: AgentDriverId
  readonly activationId: AgentDriverActivationId
  /** Current generic activation phase. */
  readonly phase: 'starting' | 'active' | 'stopping' | 'stopped' | 'failed' | 'unavailable'
  readonly provenance?: AgentDriverProvenance
  readonly compatibility?: AgentDriverCompatibility
  readonly discontinuity?: AgentDriverDiscontinuity
  readonly failure?: AgentDriverFailure
  /** Driver-specific activation state with unknown-kind fallback. */
  readonly driver?: AgentDriverDetail
}

/** Exact input and captured policy for one model-visible Driver request. */
export interface AgentDriverModelRequestSnapshot {
  readonly owner: AgentDriverId
  readonly activationId: AgentDriverActivationId
  readonly requestId: AgentDriverModelRequestId
  readonly turn: number
  readonly step: number
  /** Ordered messages exactly visible to the model, including image blocks. */
  readonly messages: readonly Message[]
  /** Provider system slot, when present. */
  readonly system?: string
  /** Driver-native instruction slot when it is distinct from `system`. */
  readonly instructions?: string
  /** Tool schemas exactly visible to the model. */
  readonly tools?: readonly ToolSchema[]
  /** Fully resolved provider/model call configuration. */
  readonly config: LlmCallConfig
  /** Fields materialized by exact-route adapter resolution. */
  readonly adapterDefaults?: LlmCallConfigAdapterDefaults
  /** Retry policy captured before the first attempt. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Captured exact-route capacity metadata. */
  readonly context?: RequestContext
  /** Captured input/output modalities; absence means the Driver did not know. */
  readonly modalities?: {
    readonly input?: readonly ModelModality[]
    readonly output?: readonly ModelModality[]
  }
  /** Driver-specific request data. Credentials and live cancellation handles are forbidden. */
  readonly driver?: AgentDriverDetail
}

/** One captured-policy execution attempt for an exact model request. */
export interface AgentDriverModelAttemptSnapshot {
  readonly owner: AgentDriverId
  readonly activationId: AgentDriverActivationId
  readonly requestId: AgentDriverModelRequestId
  readonly attemptId: AgentDriverModelAttemptId
  /** Zero-based attempt number under the request's captured retry policy. */
  readonly attempt: number
  readonly outcome: 'succeeded' | 'failed' | 'aborted'
  readonly usage?: TokenUsage
  readonly failure?: AgentDriverFailure
  /** Delay selected before the following attempt, when another attempt was scheduled. */
  readonly retryDelayMs?: number
  /** Driver-specific attempt facts with unknown-kind fallback. */
  readonly driver?: AgentDriverDetail
}

/** Maximum UTF-8 byte count allowed in an inline activity snapshot. */
export const AGENT_DRIVER_ACTIVITY_INLINE_MAX_BYTES = 16 * 1024

/** Immutable reference to activity data stored outside the Session event. */
export interface AgentDriverActivitySpillRef {
  /** Opaque retrieval locator; consumers do not parse it. */
  readonly locator: string
  /** Content digest including algorithm, for example `sha256:<hex>`. */
  readonly digest: string
  /** Exact stored byte length. */
  readonly bytes: number
  /** Media type when known. */
  readonly mediaType?: string
}

/** Bounded content attached to a whole activity snapshot. */
export type AgentDriverActivityData =
  | {
    readonly storage: 'inline'
    /** UTF-8 byte length of the serialized `data`; bounded by {@link AGENT_DRIVER_ACTIVITY_INLINE_MAX_BYTES}. */
    readonly bytes: number
    readonly data: JsonValue
  }
  | {
    readonly storage: 'spill'
    readonly ref: AgentDriverActivitySpillRef
  }

/** One whole semantic activity item or group snapshot. */
export interface AgentDriverActivitySnapshot {
  readonly owner: AgentDriverId
  readonly activationId: AgentDriverActivationId
  readonly activityId: AgentDriverActivityId
  /** Generic, merge-extensible activity classification. */
  readonly kind: string
  /** Generic phase interpreted as a whole-value replacement. */
  readonly phase: string
  readonly parentId?: AgentDriverActivityId
  readonly groupId?: AgentDriverActivityId
  readonly title?: string
  readonly summary?: string
  readonly data?: AgentDriverActivityData
  /** Driver-specific activity fields with unknown-kind fallback. */
  readonly driver?: AgentDriverDetail
}

/** Normalized Driver-neutral Objective phase. */
export type AgentDriverObjectivePhase =
  | 'pending'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Explicit resource accounting for an Objective. */
export interface AgentDriverObjectiveBudget {
  /** Owner-defined budget classification, such as `goal-rounds` or `tokens`. */
  readonly kind: string
  /** Unit used by `limit` and `consumed`. */
  readonly unit: string
  readonly limit?: number
  readonly consumed?: number
}

/** Human attention requested by the Objective owner. */
export interface AgentDriverObjectiveAttention {
  readonly kind: string
  readonly message?: string
}

/** Why Objective execution stopped or cannot continue. */
export interface AgentDriverObjectiveStopReason {
  readonly kind: string
  readonly message?: string
}

/** Driver-neutral whole snapshot of one owner's current Objective. */
export interface AgentDriverObjectiveSnapshot {
  readonly owner: AgentDriverId
  readonly objective: string
  readonly phase: AgentDriverObjectivePhase
  readonly budget?: AgentDriverObjectiveBudget
  readonly attention?: AgentDriverObjectiveAttention
  readonly stopReason?: AgentDriverObjectiveStopReason
  /** Owner routing data observed by the adapter, never interpreted as common Goal identity or CAS state. */
  readonly routing?: JsonValue
}

/** Lifecycle of a durable Proposed Plan document. */
export type AgentDriverProposedPlanLifecycle = 'proposed' | 'accepted' | 'rejected' | 'superseded'

/** Optional relation from one Proposed Plan to another durable subject. */
export interface AgentDriverProposedPlanRelation {
  readonly kind: string
  readonly planId?: AgentDriverProposedPlanId
  readonly data?: JsonValue
}

/** Driver-neutral whole snapshot of one Proposed Plan document. */
export interface AgentDriverProposedPlanSnapshot {
  readonly id: AgentDriverProposedPlanId
  readonly owner: AgentDriverId
  readonly title: string
  readonly content: string
  readonly lifecycle: AgentDriverProposedPlanLifecycle
  readonly relation?: AgentDriverProposedPlanRelation
  /** Owner routing data observed by the adapter. */
  readonly routing?: JsonValue
}

/** One whole lifecycle snapshot for a Driver checkpoint. */
export interface AgentDriverCheckpointSnapshot {
  readonly owner: AgentDriverId
  readonly activationId: AgentDriverActivationId
  readonly checkpointId: AgentDriverCheckpointId
  readonly phase: 'captured' | 'restored' | 'failed'
  readonly provenance?: AgentDriverProvenance
  readonly compatibility?: AgentDriverCompatibility
  readonly discontinuity?: AgentDriverDiscontinuity
  readonly failure?: AgentDriverFailure
  /** Driver-specific checkpoint fields with unknown-kind fallback. */
  readonly driver?: AgentDriverDetail
}

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
export interface SessionEventMap {
  /**
   * Whole activation snapshot emitted by any Agent Driver. The outer fields
   * remain readable when its Driver plugin is unloaded; an unknown nested
   * `driver.kind` falls back to those fields. Log-only.
   */
  'agent-driver/activation': AgentDriverActivationSnapshot
  /**
   * Exact model-visible request plus captured execution policy. It contains no
   * `AbortSignal`, provider credentials, or other live authority. Log-only.
   */
  'agent-driver/model-request': AgentDriverModelRequestSnapshot
  /** One execution attempt under a captured model-request policy. Log-only. */
  'agent-driver/model-attempt': AgentDriverModelAttemptSnapshot
  /**
   * Whole semantic activity item or group snapshot. It is not a synthetic DSH
   * `tool/*` event and contributes no derived model history. Log-only.
   */
  'agent-driver/activity': AgentDriverActivitySnapshot
  /**
   * Driver-neutral current Objective snapshot, or `null` when the owner reports
   * no current Objective. DSH `goal/change` remains the authoritative DSH Goal
   * stream and is adapted by `@deepseek-ai/dsh-objective` without duplication.
   */
  'agent-driver/objective': { objective: AgentDriverObjectiveSnapshot | null; driver?: AgentDriverDetail }
  /** Whole durable Proposed Plan document snapshot, or `null` when the owner has no current document. */
  'agent-driver/proposed-plan': { plan: AgentDriverProposedPlanSnapshot | null; driver?: AgentDriverDetail }
  /** Whole checkpoint lifecycle snapshot with provenance and compatibility facts. Log-only. */
  'agent-driver/checkpoint': AgentDriverCheckpointSnapshot
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * Rejection, empty input, cancellation, or failure may close it with no
   * step; otherwise the following identified `user/message` event or batch
   * records the messages entering the step.
   */
  'turn/start': { turn: number }
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
   * with no entered step has no `step/start` or `step/end`. The loop does not await a
   * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
   * per-request durability checkpoint, and consumers that read storage after
   * `whenIdle()` flush themselves. Success commits the turn; rejection is
   * reported live and does not prevent later work.
   */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none. A turn
   * cancelled mid-stream finalizes its delivered text/reasoning prefix as this
   * event with `interrupted: true`; undispatched tool calls are absent. The
   * marker distinguishes that prefix without re-deriving interruption from turn
   * boundaries. An aborted turn with no such event streamed no visible content.
   */
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage; interrupted?: true }
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
    meta?: JsonValue
  }
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  /**
   * Route metadata for the next request, logged only when the route or capacity
   * changes. It does not participate in request reconstruction or header equality.
   */
  'request/context': RequestContext
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}. Its payload is empty — position and `time`
   * carry the meaning.
   *
   * Locate the LAST one in stored history. A seed already ending in one is not
   * re-marked, so reopening an untouched session does not grow its log per
   * pickup and the event need not be at the current `firstLiveSeq`.
   *
   * `Session`'s constructor is the only legitimate writer. The invariant
   * companion deliberately constrains nothing here, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compaction/start` …
   * `compaction/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  'session/end-seed': Record<string, never>
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/**
 * A {@link SessionEvent} that is **on** the ordered surface — its
 * `surfaceOp` is guaranteed present (mandatory), narrowed from a
 * surface-eligible {@link SessionEvent} by checking both `type` and
 * `surfaceOp` at runtime.
 *
 * Use the `isSurfaceEvent` type guard (in `surface.ts`) to narrow a
 * `SessionEvent` to this type.
 */
export type SurfaceEvent = SessionEvent<SurfaceEventType> & { surfaceOp: SurfaceOp }

/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/**
 * Surface placement and cited source-event seqs for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /**
   * Complete set of known source-event seqs. `assistant/message` may use a
   * present empty array for a known empty provider stream; when the field is
   * absent, the event does not record which earlier events produced the message.
   * Other surface events require a non-empty set when this field is present.
   */
  sourceEventSeqs?: number[]
}

/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    /**
     * Marks an event a reader may safely skip when it does not recognize
     * `type`. Absent means required: a reader meeting an unrecognized type
     * without this marker MUST refuse to reconstruct the session instead of
     * silently dropping the event, because an unrecognized required event may
     * change how the rest of the log is interpreted. A writer sets `true` only
     * on purely informational records whose loss cannot affect reconstruction;
     * defaulting to required means a forgotten marker over-refuses (an
     * inconvenience) rather than silently resuming a gutted session.
     */
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of earlier events that this event cites as sources
     * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
     * or the surface nodes shadowed by a compaction replace node). An
     * `assistant/message` may carry a present empty array for a known empty
     * provider stream; when the field is absent, the event does not record which
     * earlier events produced the message.
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
