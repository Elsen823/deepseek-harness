import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentCancelCause, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  AgentDriverId,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import SessionRuntimeRegistry from '@deepseek-ai/dsh-session-runtime'

function header(id: string, driverId = 'dsh'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    driverId: AgentDriverId(driverId),
    id: SessionId(id),
    createdAt: 1,
  }
}

function fakeAgent(ctx: Context, value: SessionHeader, status: 'idle' | 'running' = 'idle'): Agent {
  const session = Session.create(value.id, [], value)
  const options: AgentOptions = {}
  const shell = {
    id: session.id,
    options,
    session,
    status,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: (_cause: AgentCancelCause) => {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  const scope = createScope(ctx, shell)
  Object.assign(shell, {
    ctx: scope.ctx.extend({ agent: shell }),
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
  })
  return shell
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionRuntimeRegistry)
  return ctx
}

describe('SessionRuntimeRegistry', () => {
  it('materializes immutable cold values and rejects Driver conflicts', async () => {
    const ctx = await harness()
    const session = header('cold')

    const first = ctx.sessionRuntimes.observe(session)
    expect(first).toMatchObject({
      sessionId: session.id,
      driverId: session.driverId,
      availability: { kind: 'cold' },
      attention: { approvals: 0, userInputs: 0 },
      operation: 'conversation',
      revision: 1,
    })
    expect(ctx.sessionRuntimes.observe(session)).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => ctx.sessionRuntimes.observe({ ...session, driverId: AgentDriverId('codex') }))
      .toThrow(/driver conflict/)
    await ctx.fiber.dispose()
  })

  it('combines activation, live Agent activity, attention, and unavailable fallback', async () => {
    const ctx = await harness()
    const session = header('active')
    const activation = ctx.sessionRuntimes.begin(session, {
      phase: 'connecting',
      operation: 'planning',
      detail: { kind: 'codex-host', data: { version: '0.149.0' } },
    })
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: { kind: 'activating', phase: 'connecting' },
      operation: 'planning',
      detail: { kind: 'codex-host', data: { version: '0.149.0' } },
    })

    const releaseApproval = ctx.sessionRuntimes.attend(session, 'approval')
    const releaseInput = ctx.sessionRuntimes.attend(session, 'user-input')
    expect(ctx.sessionRuntimes.get(session.id)?.attention).toEqual({ approvals: 1, userInputs: 1 })

    const agent = fakeAgent(ctx, session)
    ctx.emit('agent/created', { agent })
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: { kind: 'available' },
      activity: 'idle',
      operation: 'planning',
    })
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(ctx.sessionRuntimes.get(session.id)?.activity).toBe('running')

    activation.setUnavailable({ code: 'host-disconnected', message: 'Codex host disconnected', retryable: true })
    expect(ctx.sessionRuntimes.get(session.id)?.availability.kind).toBe('available')
    ctx.emit('agent/disposed', { agent })
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: {
        kind: 'unavailable',
        reason: { code: 'host-disconnected', retryable: true },
      },
    })

    await releaseApproval()
    await releaseInput()
    activation.dispose()
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: { kind: 'cold' },
      attention: { approvals: 0, userInputs: 0 },
      operation: 'conversation',
    })
    await ctx.fiber.dispose()
  })

  it('binds activation and attention contributions to their calling effects', async () => {
    const ctx = await harness()
    const session = header('effects')
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionRuntimes.begin(session, { phase: 'resuming' })
      inner.sessionRuntimes.attend(session, 'approval')
    }, { inject: ['sessionRuntimes'] }))
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: { kind: 'activating', phase: 'resuming' },
      attention: { approvals: 1, userInputs: 0 },
    })

    await owner.dispose()
    expect(ctx.sessionRuntimes.get(session.id)).toMatchObject({
      availability: { kind: 'cold' },
      attention: { approvals: 0, userInputs: 0 },
    })
    await ctx.fiber.dispose()
  })

  it('rejects duplicate activation ownership and invalid external detail', async () => {
    const ctx = await harness()
    const session = header('exclusive')
    const activation = ctx.sessionRuntimes.begin(session, { phase: 'connecting' })
    expect(() => ctx.sessionRuntimes.begin(session, { phase: 'other' })).toThrow(/already exists/)
    expect(() => { activation.setDetail({ kind: 'bad', data: { value: undefined } as never }) })
      .toThrow(/lossless JSON/)
    expect(() => { activation.setUnavailable({ code: 'BAD', message: 'x', retryable: false }) })
      .toThrow(/lower-kebab-case/)
    activation.dispose()
    await ctx.fiber.dispose()
  })

  it('emits monotonic whole values, contains ordinary observers, and forgets only unowned entries', async () => {
    const ctx = await harness()
    const a = header('z-session')
    const b = header('a-session')
    const revisions: number[] = []
    ctx.on('session-runtime/status', ({ status }) => {
      revisions.push(status.revision)
      if (status.sessionId === a.id) throw new Error('observer failure')
    })

    ctx.sessionRuntimes.observe(a)
    const activation = ctx.sessionRuntimes.begin(a, { phase: 'connecting' })
    activation.setPhase('handshake')
    activation.setPhase('handshake')
    ctx.sessionRuntimes.observe(b)
    expect(ctx.sessionRuntimes.list().map(status => status.sessionId)).toEqual([b.id, a.id])
    expect(revisions).toEqual([1, 2, 3, 1])
    expect(() => { ctx.sessionRuntimes.forget(a.id) }).toThrow(/contributions are live/)
    activation.dispose()
    ctx.sessionRuntimes.forget(a.id)
    expect(ctx.sessionRuntimes.get(a.id)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
