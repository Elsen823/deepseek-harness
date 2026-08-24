import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, {
  AgentDriverId,
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionPreparation,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import AgentRegistry, {
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentDriver,
  type AgentOptions,
  type PreparedAgentDriver,
} from '@deepseek-ai/dsh-agent'

const fakeScopes = new WeakMap<Agent, ReturnType<typeof createScope>>()

function fakeAgent(ctx: Context, session: Session, options: AgentOptions, order: string[]): Agent {
  const agent = {
    id: session.id,
    options,
    session,
    status: 'idle' as const,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: (_cause: AgentCancelCause) => { order.push(`cancel:${session.id}`) },
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => {
      order.push(`idle:${session.id}`)
      return Promise.resolve()
    },
  } as unknown as Agent
  const scope = createScope(ctx, agent)
  fakeScopes.set(agent, scope)
  Object.assign(agent, {
    ctx: scope.ctx.extend({ agent }),
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
  })
  agent.ctx.effect(() => () => { order.push(`scope:${session.id}`) })
  return agent
}

class FakeDriver implements AgentDriver {
  readonly info
  readonly prepared: SessionId[] = []

  constructor(
    private readonly ctx: Context,
    id: string,
    private readonly order: string[],
    private readonly disposeGate?: Promise<void>,
  ) {
    this.info = Object.freeze({ id: AgentDriverId(id), name: `Driver ${id}` })
  }

  prepare(session: Session, options: AgentOptions): PreparedAgentDriver {
    this.prepared.push(session.id)
    const agent = fakeAgent(this.ctx, session, options, this.order)
    return {
      agent,
      start: (source) => { this.order.push(`start:${session.id}:${source}`) },
      dispose: async () => {
        agent.cancel({ kind: 'disposed' })
        await this.disposeGate
        await agent.whenIdle()
        await fakeScopes.get(agent)?.dispose()
        this.order.push(`driver:${session.id}`)
      },
    }
  }
}

class PreparedPersistence extends SessionPersistence {
  readonly supportsRawArtifacts = false
  prepareCalls = 0
  releaseCalls = 0

  constructor(ctx: Context, private readonly header: SessionHeader) {
    super(ctx)
  }

  override prepare(id: SessionId): Promise<SessionPreparation> {
    this.prepareCalls += 1
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('SessionStore is not configured')
    return Promise.resolve(SessionPreparation.create(sessions.prepare(id, {
      seed: [],
      meta: structuredClone(this.header),
      seedSource: 'persistence',
    }), { release: () => { this.releaseCalls += 1 } }))
  }

  locate(): SessionLocation | undefined { return undefined }
  create(): Promise<void> { return Promise.resolve() }
  append(): Promise<void> { return Promise.resolve() }
  load(): Promise<SessionInspection> { throw new Error('not used') }
  inspect(): Promise<SessionInspection> { throw new Error('not used') }
  readFrom(): Promise<{ meta: SessionHeader; events: SessionEvent[] }> { throw new Error('not used') }
  list(): Promise<SessionHeader[]> { return Promise.resolve([this.header]) }
  listSnapshots(): Promise<SessionPersistenceSnapshot[]> { return Promise.resolve([]) }
}

async function harness(defaultDriverId = AgentDriverId('dsh')): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry, { defaultDriverId })
  return ctx
}

describe('Agent Driver shared lifecycle', () => {
  it('selects explicit and default Drivers simultaneously and persists each binding', async () => {
    const ctx = await harness(AgentDriverId('alpha'))
    const order: string[] = []
    const alpha = new FakeDriver(ctx, 'alpha', order)
    const beta = new FakeDriver(ctx, 'beta', order)
    ctx.agents.registerDriver(beta)
    ctx.agents.registerDriver(alpha)

    const first = await ctx.agents.create({ sessionId: SessionId('first') })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), driverId: AgentDriverId('beta') })

    expect(first.agent.session.header.driverId).toBe(AgentDriverId('alpha'))
    expect(second.agent.session.header.driverId).toBe(AgentDriverId('beta'))
    expect(alpha.prepared).toEqual([SessionId('first')])
    expect(beta.prepared).toEqual([SessionId('second')])
    expect(ctx.agents.list()).toEqual([first.agent, second.agent])

    await Promise.all([first.dispose(), second.dispose()])
    await ctx.fiber.dispose()
  })

  it('prepares persistence once and resumes with the stored Driver rather than the default', async () => {
    const ctx = await harness(AgentDriverId('alpha'))
    const order: string[] = []
    const alpha = new FakeDriver(ctx, 'alpha', order)
    const beta = new FakeDriver(ctx, 'beta', order)
    ctx.agents.registerDriver(alpha)
    ctx.agents.registerDriver(beta)
    const id = SessionId('stored-beta')
    await ctx.plugin(PreparedPersistence, {
      version: SESSION_FORMAT_VERSION,
      driverId: AgentDriverId('beta'),
      id,
      createdAt: 1,
    })

    const handle = await ctx.agents.resume({ resumeSessionId: id })

    expect((ctx.sessionPersistence as PreparedPersistence).prepareCalls).toBe(1)
    expect(alpha.prepared).toEqual([])
    expect(beta.prepared).toEqual([id])
    expect(handle.agent.session.header.driverId).toBe(AgentDriverId('beta'))
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('releases an owned persistence preparation when its stored Driver is unavailable', async () => {
    const ctx = await harness()
    const id = SessionId('missing-stored-driver')
    await ctx.plugin(PreparedPersistence, {
      version: SESSION_FORMAT_VERSION,
      driverId: AgentDriverId('missing'),
      id,
      createdAt: 1,
    })

    await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toThrow(
      'no agent driver "missing" is registered',
    )
    expect((ctx.sessionPersistence as PreparedPersistence).releaseCalls).toBe(1)
    expect(ctx.sessions.get(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('publishes in order and rolls setup or commit failures back unpublished', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))
    ctx.on('session/created', () => { order.push('session') })
    ctx.on('agent/created', () => { order.push('agent') })
    ctx.on('agent/session-start', () => { order.push('session-start') })

    const handle = await ctx.agents.create({
      sessionId: SessionId('ordered'),
      setup: () => ({ commit: () => { order.push('commit') } }),
    })
    expect(order.slice(0, 5)).toEqual(['commit', 'session', 'agent', 'session-start', 'start:ordered:startup'])
    await handle.dispose()

    await expect(ctx.agents.create({
      sessionId: SessionId('setup-fails'),
      setup: () => { throw new Error('setup failed') },
    })).rejects.toThrow('setup failed')
    await expect(ctx.agents.create({
      sessionId: SessionId('commit-fails'),
      setup: () => ({ commit: () => { throw new Error('commit failed') } }),
    })).rejects.toThrow('commit failed')
    expect(ctx.agents.get(SessionId('setup-fails'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('commit-fails'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('drains Driver work and scope before Agent and Session detach', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))
    ctx.on('agent/disposed', () => { order.push('agent-disposed') })
    ctx.on('session/disposed', () => { order.push('session-disposed') })
    const handle = await ctx.agents.create({ sessionId: SessionId('dispose-order') })

    await handle.dispose()

    expect(order.slice(-6)).toEqual([
      'cancel:dispose-order',
      'idle:dispose-order',
      'scope:dispose-order',
      'driver:dispose-order',
      'agent-disposed',
      'session-disposed',
    ])
    await ctx.fiber.dispose()
  })

  it('cancels unpublished preparation without publishing either registry entry', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))
    const controller = new AbortController()
    const reason = new Error('cancel Driver preparation')
    controller.abort(reason)

    await expect(ctx.agents.create({
      sessionId: SessionId('cancelled'),
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(ctx.agents.get(SessionId('cancelled'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('cancelled'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('waits for an abandoned prepared Agent disposer before removing its Driver generation', async () => {
    const ctx = await harness()
    const order: string[] = []
    const prepareEntered = Promise.withResolvers<undefined>()
    const finishPrepare = Promise.withResolvers<undefined>()
    const disposeEntered = Promise.withResolvers<undefined>()
    const finishDispose = Promise.withResolvers<undefined>()
    const driver: AgentDriver = {
      info: Object.freeze({ id: AgentDriverId('dsh'), name: 'Driver dsh' }),
      async prepare(session, options) {
        prepareEntered.resolve(undefined)
        await finishPrepare.promise
        const agent = fakeAgent(ctx, session, options, order)
        return {
          agent,
          start: () => {},
          dispose: async () => {
            disposeEntered.resolve(undefined)
            await finishDispose.promise
            await fakeScopes.get(agent)?.dispose()
          },
        }
      },
    }
    const provider = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.registerDriver(driver)
    }, { inject: ['agents'] }))
    const creating = ctx.agents.create({ sessionId: SessionId('abandoned-prepare') })
    await prepareEntered.promise

    const unloading = provider.dispose()
    finishPrepare.resolve(undefined)
    await disposeEntered.promise
    let unloaded = false
    void unloading.then(() => { unloaded = true })
    await Promise.resolve()
    expect(unloaded).toBe(false)

    finishDispose.resolve(undefined)
    await expect(creating).rejects.toThrow('agent driver "dsh" is not active')
    await unloading
    expect(() => ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('drains one Driver generation on unload and permits same-id HMR replacement', async () => {
    const ctx = await harness()
    const order: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const provider = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.registerDriver(new FakeDriver(ctx, 'dsh', order, gate.promise))
    }, { inject: ['agents'] }))
    const handle = await ctx.agents.create({ sessionId: SessionId('hmr-live') })

    const unloading = provider.dispose()
    expect(() => ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order)))
      .toThrow('agent driver "dsh" is already registered')
    await expect(ctx.agents.create({ sessionId: SessionId('hmr-overlap') }))
      .rejects.toThrow('agent driver "dsh" is not active')
    gate.resolve(undefined)
    await unloading

    expect(ctx.agents.get(SessionId('hmr-live'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('hmr-live'))).toBeUndefined()
    expect(order).toContain('scope:hmr-live')
    await handle.dispose()
    ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))
    const replacement = await ctx.agents.create({ sessionId: SessionId('hmr-live') })
    await replacement.dispose()
    await ctx.fiber.dispose()
  })

  it('lets only one simultaneous same-id publication win', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.agents.registerDriver(new FakeDriver(ctx, 'dsh', order))
    const gate = Promise.withResolvers<undefined>()
    const setup = async (): Promise<void> => { await gate.promise }
    const id = SessionId('same-id')
    const first = ctx.agents.create({ sessionId: id, setup })
    const second = ctx.agents.create({ sessionId: id, setup })
    gate.resolve(undefined)

    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const winner = outcomes.find(outcome => outcome.status === 'fulfilled') as PromiseFulfilledResult<Awaited<typeof first>>
    await winner.value.dispose()
    await ctx.fiber.dispose()
  })
})
