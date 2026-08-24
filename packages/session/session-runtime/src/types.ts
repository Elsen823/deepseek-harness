/**
 * Client-safe Session runtime status vocabulary.
 * @module @deepseek-ai/dsh-session-runtime/types
 */

import type { AgentDriverId, JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'

/** Availability of the process-local execution resources for one durable Session. */
export type SessionRuntimeAvailability =
  | { readonly kind: 'cold' }
  | { readonly kind: 'activating'; readonly phase: string }
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable'; readonly reason: SessionRuntimeUnavailableReason }

/** Stable diagnosis shown when a Session cannot currently activate its Driver. */
export interface SessionRuntimeUnavailableReason {
  /** Lower-kebab-case machine classification. */
  readonly code: string
  /** Non-empty human-readable diagnosis. */
  readonly message: string
  /** Whether retrying without configuration or compatibility changes can succeed. */
  readonly retryable: boolean
}

/** Driver-neutral operations that can label the current running work. */
export interface SessionRuntimeOperationMap {
  conversation: 'conversation'
  planning: 'planning'
  review: 'review'
  compaction: 'compaction'
}

/** Merge-extensible current operation label. */
export type SessionRuntimeOperation = SessionRuntimeOperationMap[keyof SessionRuntimeOperationMap]

/** Counts of independently pending human-attention requests. */
export interface SessionRuntimeAttention {
  /** Pending approval decisions. */
  readonly approvals: number
  /** Pending structured or free-form user-input requests. */
  readonly userInputs: number
}

/** Opaque presentation and diagnostics supplied by the bound Driver. */
export interface SessionRuntimeDetail {
  /** Stable Driver-owned detail kind. */
  readonly kind: string
  /** Lossless-JSON payload; generic scheduling and completion consumers ignore it. */
  readonly data: JsonValue
}

/** Current process-local runtime state for one durable Session. */
export interface SessionRuntimeStatus {
  /** Durable Session identity. */
  readonly sessionId: SessionId
  /** Immutable Driver binding copied from the Session header. */
  readonly driverId: AgentDriverId
  /** Whether this process can currently execute the Session. */
  readonly availability: SessionRuntimeAvailability
  /** Binary whole-Agent activity, present exactly while a live Agent is available. */
  readonly activity?: 'idle' | 'running'
  /** Independently pending requests for human attention. */
  readonly attention: SessionRuntimeAttention
  /** Current Driver-neutral work category. */
  readonly operation: SessionRuntimeOperation
  /** Optional Driver-owned presentation or diagnostic detail. */
  readonly detail?: SessionRuntimeDetail
  /** Process-local monotonic revision for wire ordering. */
  readonly revision: number
  /** Unix epoch milliseconds when this revision committed. */
  readonly updatedAt: number
}

/** Initial state of one exclusive Driver activation contribution. */
export interface SessionRuntimeActivationSpec {
  /** Non-empty phase rendered while no live Agent has published. */
  readonly phase: string
  /** Initial operation; defaults to `conversation`. */
  readonly operation?: SessionRuntimeOperation
  /** Optional detached Driver detail. */
  readonly detail?: SessionRuntimeDetail
}

/** Human-attention contribution kind. */
export type SessionRuntimeAttentionKind = 'approval' | 'user-input'

/** Capability that mutates one exact Driver activation contribution. */
export interface SessionRuntimeActivation {
  /** Session owned by this contribution. */
  readonly sessionId: SessionId
  /** Driver owned by this contribution. */
  readonly driverId: AgentDriverId
  /** Replace the activating phase while the contribution is live. */
  setPhase(phase: string): void
  /** Replace the Driver-neutral current operation. */
  setOperation(operation: SessionRuntimeOperation): void
  /** Replace or clear Driver-owned detail. */
  setDetail(detail: SessionRuntimeDetail | undefined): void
  /** Mark this activation unavailable with an explicit diagnosis. */
  setUnavailable(reason: SessionRuntimeUnavailableReason): void
  /** Release the contribution. Repeated calls are no-ops. */
  dispose(): void
}
