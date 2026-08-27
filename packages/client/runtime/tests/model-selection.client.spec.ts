import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import {
  applyModelSelectionIdentity,
  emptyModelSelectionIdentity,
  foldModelSelectionIdentity,
} from '../src/client/sessions/model-selection.ts'

const sid = 'session-identities' as SessionId

function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

describe('client Model Selection identity fold', () => {
  it('keeps Selected and Effective separate and marks a changed selection for the next Turn', () => {
    const selected = event('model/selected', 1, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', source: 'user',
    })
    const header = event('request/header', 2, {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
      reason: 'initial',
    })
    const switched = event('model/selected', 3, {
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', source: 'user',
    })
    const identity = foldModelSelectionIdentity([selected, header, switched], sid)
    expect(identity).toMatchObject({
      dshSessionId: sid,
      selected: {
        selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
        source: 'user', seq: 3,
      },
      effective: {
        selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' },
        source: 'request/header', seq: 2,
      },
      nextTurn: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    })
  })

  it('projects native model and conversation identities from Driver evidence', () => {
    const initial = emptyModelSelectionIdentity(sid)
    const activation = event('agent-driver/activation', 4, {
      owner: 'codex',
      activationId: 'activation',
      phase: 'active',
      provenance: { kind: 'created', nativeConversationId: 'thread-1' },
    })
    const request = event('agent-driver/model-request', 5, {
      owner: 'codex',
      activationId: 'activation',
      requestId: 'request',
      turn: 1,
      step: 1,
      messages: [],
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      driver: {
        kind: 'codex/responses-request',
        payload: {
          threadId: 'thread-1',
          nativeSelection: { model: 'codex-flash', effort: 'high' },
        },
      },
    })
    const afterActivation = applyModelSelectionIdentity(initial, activation)
    const identity = applyModelSelectionIdentity(afterActivation, request)
    expect(identity).toMatchObject({
      dshSessionId: sid,
      nativeConversationId: 'thread-1',
      native: { model: 'codex-flash', effort: 'high' },
      effective: {
        selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        source: 'agent-driver/model-request', seq: 5,
      },
    })
  })

  it('projects a first-turn native conversation identity from checkpoint provenance', () => {
    const initial = emptyModelSelectionIdentity(sid)
    const activation = event('agent-driver/activation', 4, {
      owner: 'claude',
      activationId: 'activation',
      phase: 'active',
    })
    const request = event('agent-driver/model-request', 5, {
      owner: 'claude',
      activationId: 'activation',
      requestId: 'request',
      turn: 1,
      step: 1,
      messages: [],
      config: { provider: 'anthropic', model: 'sonnet' },
      driver: {
        kind: 'claude/native-request',
        payload: {
          nativeSelection: { model: 'claude-sonnet-4-6', effort: 'high' },
          nativeOptions: { model: 'claude-sonnet-4-6', sessionId: 'native-1' },
        },
      },
    })
    const checkpoint = event('agent-driver/checkpoint', 6, {
      owner: 'claude',
      activationId: 'activation',
      checkpointId: 'checkpoint',
      phase: 'captured',
      provenance: { kind: 'created', nativeConversationId: 'native-1' },
    })

    const afterRequest = [activation, request].reduce(applyModelSelectionIdentity, initial)
    expect(afterRequest.native).toEqual({ model: 'claude-sonnet-4-6', effort: 'high' })
    expect(afterRequest).not.toHaveProperty('nativeConversationId')

    const identity = applyModelSelectionIdentity(afterRequest, checkpoint)
    expect(identity.nativeConversationId).toBe('native-1')
  })

  it('keeps an unchanged identity reference for unrelated events', () => {
    const first = foldModelSelectionIdentity([], sid)
    expect(applyModelSelectionIdentity(first, event('turn/start', 1, { turn: 1 }))).toBe(first)
  })
})
