/** Durable Web projection of Session Model Selection identities. */

import type { ModelSelection as WireModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeConversationId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** Provider/model/adapter-effort value shown in one identity row. */
export type ModelSelectionIdentityValue = WireModelSelection

/** Accepted intent with its durable source and event sequence. */
export interface SelectedModelIdentity {
  readonly selection: ModelSelectionIdentityValue
  readonly source: 'user' | 'default'
  readonly seq: number
}

/** Effective request evidence with its durable source and event sequence. */
export interface EffectiveModelIdentity {
  readonly selection: ModelSelectionIdentityValue
  readonly source: 'request/header' | 'agent-driver/model-request'
  readonly seq: number
}

/** Native model identity attached to Driver request evidence. */
export interface NativeModelIdentity {
  readonly model: string
  readonly effort?: string
}

/** Compact identity presentation for one DSH Session. */
export interface ModelSelectionIdentity {
  /** DSH-owned Session identity; this is distinct from native conversations. */
  readonly dshSessionId: SessionId
  /** Latest accepted intent, whether it is effective yet or awaits the next Turn. */
  readonly selected?: SelectedModelIdentity
  /** Selected value that differs from the latest effective request. */
  readonly nextTurn?: ModelSelectionIdentityValue
  /** Latest request/Driver evidence that reached a model boundary. */
  readonly effective?: EffectiveModelIdentity
  /** Native model and adapter-owned native effort, when a Driver supplies them. */
  readonly native?: NativeModelIdentity
  /** Opaque native conversation identity from generic Driver provenance. */
  readonly nativeConversationId?: NativeConversationId
}

/** Create the empty identity projection for one Session.
 * @param sessionId - DSH Session identity carried by the projection.
 * @returns An identity projection with no selected, effective, or native evidence.
 */
export function emptyModelSelectionIdentity(sessionId: SessionId): ModelSelectionIdentity {
  return { dshSessionId: sessionId }
}

function sameSelection(a: ModelSelectionIdentityValue | undefined, b: ModelSelectionIdentityValue | undefined): boolean {
  return a?.provider === b?.provider
    && a?.model === b?.model
    && a?.reasoningEffort === b?.reasoningEffort
}

function selectionOf(config: { provider: string; model: string; reasoningEffort?: string }): ModelSelectionIdentityValue {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read the generic native conversation provenance without inspecting Driver detail. */
function nativeConversationIdOf(value: unknown): NativeConversationId | undefined {
  const provenance = record(record(value)?.provenance)
  const nativeConversationId = nonEmptyString(provenance?.nativeConversationId)
  return nativeConversationId === undefined ? undefined : NativeConversationId(nativeConversationId)
}

function nativeOf(payload: unknown): { native?: NativeModelIdentity; nativeConversationId?: NativeConversationId } {
  const value = record(payload)
  const native = record(value?.nativeSelection)
  const model = nonEmptyString(native?.model)
  const effort = nonEmptyString(native?.effort)
  const threadId = nonEmptyString(value?.threadId)
  return {
    ...model === undefined ? {} : { native: { model, ...effort === undefined ? {} : { effort } } },
    ...threadId === undefined ? {} : { nativeConversationId: NativeConversationId(threadId) },
  }
}

function withNextTurn(identity: ModelSelectionIdentity): ModelSelectionIdentity {
  const selected = identity.selected?.selection
  const effective = identity.effective?.selection
  const nextTurn = selected !== undefined && effective !== undefined && !sameSelection(selected, effective)
    ? selected
    : undefined
  const { nextTurn: _previous, ...withoutNextTurn } = identity
  return {
    ...withoutNextTurn,
    ...nextTurn === undefined ? {} : { nextTurn },
  }
}

/** Apply one durable Session event to the compact identity projection.
 * @param state - Current identity projection.
 * @param event - Durable Session event to fold.
 * @returns The updated projection, or the same reference when the event is unrelated.
 */
export function applyModelSelectionIdentity(
  state: ModelSelectionIdentity,
  event: SessionEvent,
): ModelSelectionIdentity {
  let next = state
  switch (event.type) {
    case 'model/selected': {
      const selected: SelectedModelIdentity = {
        selection: selectionOf(event.data),
        source: event.data.source,
        seq: event.seq,
      }
      next = { ...state, selected }
      break
    }
    case 'request/header': {
      const effective: EffectiveModelIdentity = {
        selection: selectionOf(event.data.header.config),
        source: 'request/header',
        seq: event.seq,
      }
      next = { ...state, effective }
      break
    }
    case 'agent-driver/model-request': {
      const effective: EffectiveModelIdentity = {
        selection: selectionOf(event.data.config),
        source: 'agent-driver/model-request',
        seq: event.seq,
      }
      const native = nativeOf(event.data.driver?.payload)
      next = {
        ...state,
        effective,
        ...native.native === undefined ? {} : { native: native.native },
        ...native.nativeConversationId === undefined ? {} : { nativeConversationId: native.nativeConversationId },
      }
      break
    }
    case 'agent-driver/activation':
    case 'agent-driver/checkpoint': {
      const nativeConversationId = nativeConversationIdOf(event.data)
      if (nativeConversationId !== undefined) next = { ...state, nativeConversationId }
      break
    }
    default:
      return state
  }
  return withNextTurn(next)
}

/** Fold a contiguous Session event window into a compact identity projection.
 * @param events - Ordered Session events from one contiguous window.
 * @param sessionId - DSH Session identity carried by the projection.
 * @returns The folded identity projection.
 */
export function foldModelSelectionIdentity(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): ModelSelectionIdentity {
  let state = emptyModelSelectionIdentity(sessionId)
  for (const event of events) state = applyModelSelectionIdentity(state, event)
  return state
}
