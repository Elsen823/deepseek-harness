import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  AGENT_DRIVER_ACTIVITY_INLINE_MAX_BYTES,
  AgentDriverActivationId,
  AgentDriverActivityId,
  AgentDriverId,
  AgentDriverModelRequestId,
  SessionId,
} from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import { KNOWN_SESSION_EVENT_TYPES } from '../src/known-event-types.ts'

async function sessionWithInvariants() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  return ctx.sessions.create(SessionId('agent-driver-events'), {
    meta: { driverId: AgentDriverId('codex') },
  })
}

describe('Agent Driver durable facts', () => {
  it('keeps the complete outer family statically known and required-on-read', () => {
    expect([...KNOWN_SESSION_EVENT_TYPES].filter(type => type.startsWith('agent-driver/'))).toEqual([
      'agent-driver/activation',
      'agent-driver/activity',
      'agent-driver/checkpoint',
      'agent-driver/model-attempt',
      'agent-driver/model-request',
      'agent-driver/objective',
      'agent-driver/proposed-plan',
    ])
    expect(KNOWN_SESSION_EVENT_TYPES.has('agent-driver/future-event')).toBe(false)
  })

  it('round-trips an exact model-visible request snapshot losslessly', async () => {
    const session = await sessionWithInvariants()
    const request = session.append('agent-driver/model-request', {
      owner: AgentDriverId('codex'),
      activationId: AgentDriverActivationId('activation-1'),
      requestId: AgentDriverModelRequestId('request-1'),
      turn: 2,
      step: 3,
      messages: [freezeMessage({
        id: MessageId('message-1'),
        role: 'user',
        source: { kind: 'user' },
        content: [{
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('attachment-1'),
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
          },
        }, { type: 'text', text: 'inspect this image' }],
      })],
      system: 'system text',
      instructions: 'driver instructions',
      tools: [{ name: 'lookup', description: 'Look up a value.', parameters: { type: 'object' } }],
      config: {
        provider: 'mock',
        model: 'vision-model',
        reasoningEffort: 'high' as never,
        temperature: 0.2,
        maxTokens: 4096,
        stop: ['DONE'],
      },
      adapterDefaults: { maxTokens: true },
      retryPolicy: {
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: ['RATE_LIMIT'],
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
      context: { provider: 'mock', model: 'vision-model', contextWindow: 128_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      driver: { kind: 'codex/request', payload: { nativeSetting: 'exact' } },
    })

    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
    expect(request.data.messages[0]?.content[0]).toMatchObject({
      type: 'image',
      attachment: { attachmentId: 'attachment-1' },
    })
    expect(request.data).not.toHaveProperty('signal')
    expect(request.data).not.toHaveProperty('credentials')
  })

  it('keeps unknown Driver detail readable through the known outer family', async () => {
    const session = await sessionWithInvariants()
    const event = session.append('agent-driver/activation', {
      owner: AgentDriverId('future-driver'),
      activationId: AgentDriverActivationId('future-activation'),
      phase: 'active',
      provenance: { kind: 'imported', nativeConversationId: 'opaque-native-id' },
      driver: { kind: 'future-driver/v9', payload: { retained: true } },
    })

    expect(event.type).toBe('agent-driver/activation')
    expect(event.data.owner).toBe('future-driver')
    expect(event.data.phase).toBe('active')
    expect(event.data.driver).toEqual({ kind: 'future-driver/v9', payload: { retained: true } })
  })

  it('enforces the declared inline activity byte bound', async () => {
    const session = await sessionWithInvariants()
    expect(() => session.append('agent-driver/activity', {
      owner: AgentDriverId('codex'),
      activationId: AgentDriverActivationId('activation-1'),
      activityId: AgentDriverActivityId('activity-1'),
      kind: 'analysis',
      phase: 'completed',
      data: {
        storage: 'inline',
        bytes: AGENT_DRIVER_ACTIVITY_INLINE_MAX_BYTES + 1,
        data: 'small',
      },
    })).toThrow(/inline bytes/)

    const payload = { answer: 42 }
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength
    expect(() => session.append('agent-driver/activity', {
      owner: AgentDriverId('codex'),
      activationId: AgentDriverActivationId('activation-1'),
      activityId: AgentDriverActivityId('activity-2'),
      kind: 'analysis',
      phase: 'completed',
      data: { storage: 'inline', bytes, data: payload },
    })).not.toThrow()
  })
})
