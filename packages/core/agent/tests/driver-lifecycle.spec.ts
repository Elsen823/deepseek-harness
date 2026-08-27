import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, {
  AgentDriverId,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry, {
  Inbox,
  RestartHandoffStore,
  createModelSelectionOwner,
  type Agent,
  type AgentHandle,
  type AgentCancelCause,
  type AgentDriver,
  type AgentOptions,
  type PreparedAgentDriver,
  type Config as AgentConfig,
} from '@deepseek-ai/dsh-agent'

const fakeScopes = new WeakMap<Agent, ReturnType<typeof createScope>>()

function fakeAgent(
  ctx: Context,
  session: Session,
  options: AgentOptions,
  order: string[],
  idleGate?: Promise<void>,
): Agent {
  const agent = {
    id: session.id,
    options,
    session,
    modelSelection: createModelSelectionOwner(session),
    status: 'idle' as const,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: (_cause: AgentCancelCause) => { order.push(`cancel:${session.id}`) },
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => {
      order.push(`idle:${session.id}`)
      return idleGate ?? Promise.resolve()
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
  handoffCalls = 0
  handoffCommits = 0
  disposeCalls = 0
  validateModelSelection: NonNullable<AgentDriver['validateModelSelection']> = () => {}

  constructor(
    private readonly ctx: Context,
    id: string,
    private readonly order: string[],
    private readonly disposeGate?: Promise<void>,
    private readonly handoffState?: { readonly nativeThreadId: string },
    private readonly idleGate?: Promise<void>,
    private readonly handoffCommitError?: Error,
  ) {
    this.info = Object.freeze({ id: AgentDriverId(id), name: `Driver ${id}` })
  }

  prepare(session: Session, options: AgentOptions): PreparedAgentDriver {
    this.prepared.push(session.id)
    const agent = fakeAgent(this.ctx, session, options, this.order, this.idleGate)
    return {
      agent,
      start: (source) => { this.order.push(`start:${session.id}:${source}`) },
      ...(this.handoffState === undefined ? {} : {
        handoff: async () => {
          this.handoffCalls += 1
          return {
            state: { nativeThreadId: this.handoffState?.nativeThreadId as string },
            commit: () => {
              this.handoffCommits += 1
              if (this.handoffCommitError !== undefined) throw this.handoffCommitError
            },
          }
        },
      }),
      dispose: async () => {
        this.disposeCalls += 1
        agent.cancel({ kind: 'disposed' })
        await this.disposeGate
        await this.idleGate
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

  private readonly seed: readonly SessionEvent[]

  constructor(
    ctx: Context,
    headerOrOptions: SessionHeader | { readonly header: SessionHeader; readonly events?: readonly SessionEvent[] },
  ) {
    super(ctx)
    this.header = 'header' in headerOrOptions ? headerOrOptions.header : headerOrOptions
    this.seed = 'header' in headerOrOptions ? headerOrOptions.events ?? [] : []
  }

  private readonly header: SessionHeader

  override prepare(id: SessionId): Promise<SessionPreparation> {
    this.prepareCalls += 1
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('SessionStore is not configured')
    return Promise.resolve(SessionPreparation.create(sessions.prepare(id, {
      seed: [...this.seed],
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

async function harness(
  defaultDriverId = AgentDriverId('dsh'),
  agentConfig: Omit<AgentConfig, 'defaultDriverId'> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry, { defaultDriverId, ...agentConfig })
  return ctx
}

describe('Agent Driver shared lifecycle', () => {
  it('publishes opaque Driver contributions and removes them with the Driver generation', async () => {
    const ctx = await harness()
    const driverId = AgentDriverId('contributor')
    const driver = new FakeDriver(ctx, 'contributor', [])
    const driverRegistration: () => Promise<void> = ctx.agents.registerDriver(driver)
    const contribution: () => void = ctx.agents.registerDriverContribution({
      id: 'settings',
      driverId,
      kind: 'management',
      value: { native: 'claude-code' },
    })

    expect(ctx.agents.listDriverContributions()).toEqual([{
      id: 'settings',
      driverId,
      kind: 'management',
      value: { native: 'claude-code' },
    }])
    expect(ctx.agents.listDriverContributions(driverId)[0]?.value).toEqual({ native: 'claude-code' })
    contribution()
    expect(ctx.agents.listDriverContributions()).toEqual([])
    await driverRegistration()

    const provider = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.registerDriver(new FakeDriver(inner, 'contributor', []))
      inner.agents.registerDriverContribution({
        id: 'settings',
        driverId,
        kind: 'management',
        value: { native: 'claude-code' },
      })
    }, { inject: ['agents'] }))
    expect(ctx.agents.listDriverContributions(driverId)).toHaveLength(1)
    await provider.dispose()
    expect(ctx.agents.listDriverContributions(driverId)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a Driver that does not construct the required Session-local owner', async () => {
    const ctx = await harness()
    const order: string[] = []
    const target = new FakeDriver(ctx, 'missing-owner', order)
    ctx.agents.registerDriver({
      info: target.info,
      prepare(session, options) {
        const prepared = target.prepare(session, options)
        Reflect.deleteProperty(prepared.agent, 'modelSelection')
        return prepared
      },
    })

    await expect(ctx.agents.create({
      sessionId: SessionId('missing-owner-session'),
      driverId: AgentDriverId('missing-owner'),
    })).rejects.toThrow('without a Session-local model-selection owner')
    expect(ctx.agents.get(SessionId('missing-owner-session'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('missing-owner-session'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('preflights a seeded Model Selection against the target Driver before cross-Driver publication', async () => {
    const ctx = await harness()
    const order: string[] = []
    const target = new FakeDriver(ctx, 'target', order)
    target.validateModelSelection = async (selection) => {
      if (selection.provider !== 'target-provider') throw new Error('target Driver rejects provider')
    }
    ctx.agents.registerDriver(target)

    const source = Session.create(SessionId('source-selection'))
    source.append('model/selected', { provider: 'source-provider', model: 'model', source: 'user' })
    await expect(ctx.agents.create({
      sessionId: SessionId('target-selection'),
      driverId: AgentDriverId('target'),
      seed: source.events,
    })).rejects.toThrow('target Driver rejects provider')

    expect(target.prepared).toEqual([])
    expect(ctx.agents.get(SessionId('target-selection'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('target-selection'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

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

  it('commits an explicit resident restart handoff without ordinary disposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-'))
    try {
      const ctx = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const order: string[] = []
      const driver = new FakeDriver(ctx, 'dsh', order, undefined, { nativeThreadId: 'thread-1' })
      ctx.agents.registerDriver(driver)
      const disposed: string[] = []
      const sessionDisposed: string[] = []
      let flushes = 0
      ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) })
      ctx.on('session/disposed', (session) => { sessionDisposed.push(session.id) })
      ctx.on('session/flush', (session) => {
        if (session.id === SessionId('resident-handoff')) flushes += 1
      })
      const handle = await ctx.agents.create({ sessionId: SessionId('resident-handoff'), resident: true })
      handle.agent.session.append('session/end-seed', {})

      const result = await ctx.agents.restartHandoff({ generation: 'generation-1' })

      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({
        sessionId: SessionId('resident-handoff'),
        driverId: AgentDriverId('dsh'),
        eventSeq: 1,
        state: { nativeThreadId: 'thread-1' },
      })
      expect(driver.handoffCalls).toBe(1)
      expect(driver.handoffCommits).toBe(1)
      expect(driver.disposeCalls).toBe(0)
      expect(flushes).toBe(1)
      expect(ctx.agents.get(SessionId('resident-handoff'))).toBe(handle.agent)
      expect(disposed).toEqual([])
      expect(sessionDisposed).toEqual([])

      await ctx.fiber.dispose()
      expect(driver.disposeCalls).toBe(0)
      expect(disposed).toEqual([])
      expect(sessionDisposed).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a committed failure state when a Driver violates the infallible commit hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-commit-failure-'))
    try {
      const ctx = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const order: string[] = []
      const driver = new FakeDriver(
        ctx,
        'dsh',
        order,
        undefined,
        { nativeThreadId: 'thread-commit-failure' },
        undefined,
        new Error('Driver commit failed'),
      )
      ctx.agents.registerDriver(driver)
      const disposed: string[] = []
      const sessionDisposed: string[] = []
      ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) })
      ctx.on('session/disposed', (session) => { sessionDisposed.push(session.id) })
      const handle = await ctx.agents.create({ sessionId: SessionId('resident-commit-failure'), resident: true })

      await expect(ctx.agents.restartHandoff({ generation: 'generation-commit-failure' })).rejects.toThrow(
        'Driver commit failed after publication',
      )

      expect(ctx.agents.restartHandoffPhase).toBe('committed')
      expect(ctx.agents.get(SessionId('resident-commit-failure'))).toBe(handle.agent)
      expect(driver.handoffCommits).toBe(1)
      expect(driver.disposeCalls).toBe(0)
      expect(await new RestartHandoffStore({ directory }).list()).toHaveLength(1)
      await ctx.fiber.dispose()
      expect(driver.disposeCalls).toBe(0)
      expect(disposed).toEqual([])
      expect(sessionDisposed).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a resident restart handoff at the bound and leaves the old Agent live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-timeout-'))
    const idle = Promise.withResolvers<undefined>()
    try {
      const ctx = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 5, leaseTimeoutMs: 10_000 },
      })
      const order: string[] = []
      const driver = new FakeDriver(ctx, 'dsh', order, undefined, { nativeThreadId: 'thread-timeout' }, idle.promise)
      ctx.agents.registerDriver(driver)
      const handle = await ctx.agents.create({ sessionId: SessionId('resident-timeout'), resident: true })

      await expect(ctx.agents.restartHandoff({ generation: 'generation-timeout' })).rejects.toThrow(
        'exceeded 5ms quiescence bound',
      )
      expect(ctx.agents.get(SessionId('resident-timeout'))).toBe(handle.agent)
      expect(driver.handoffCalls).toBe(0)
      expect(driver.disposeCalls).toBe(0)
      idle.resolve(undefined)
      await Promise.resolve()
      expect(driver.handoffCommits).toBe(0)
    } finally {
      idle.resolve(undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('adopts only committed resident records and rejects a second claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-adopt-'))
    try {
      const first = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const firstOrder: string[] = []
      const firstDriver = new FakeDriver(first, 'dsh', firstOrder, undefined, { nativeThreadId: 'thread-adopt' })
      first.agents.registerDriver(firstDriver)
      const original = await first.agents.create({ sessionId: SessionId('resident-adopt'), resident: true })
      await first.agents.restartHandoff({ generation: 'generation-adopt' })
      const header = original.agent.session.header
      await first.fiber.dispose()

      const second = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      await second.plugin(PreparedPersistence, { header, events: original.agent.session.events })
      const secondOrder: string[] = []
      const secondDriver = new FakeDriver(second, 'dsh', secondOrder, undefined, { nativeThreadId: 'thread-adopt' })
      second.agents.registerDriver(secondDriver)

      const adopted = await second.agents.adoptRestartHandoffs({ claimant: 'generation-next' })

      expect(adopted.failures).toEqual([])
      expect(adopted.handles).toHaveLength(1)
      expect(adopted.handles[0]?.agent.id).toBe(SessionId('resident-adopt'))
      expect(adopted.handles[0]?.agent).not.toBe(original.agent)
      expect(secondDriver.prepared).toEqual([SessionId('resident-adopt')])
      await expect(second.agents.adoptRestartHandoffs({ claimant: 'generation-other' })).resolves.toMatchObject({
        handles: [],
        failures: [],
      })

      await adopted.handles[0]?.dispose()
      await second.fiber.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('releases a failed adoption claim without publishing or disposing a replacement Agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-cleanup-'))
    try {
      const first = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const firstOrder: string[] = []
      const firstDriver = new FakeDriver(first, 'dsh', firstOrder, undefined, { nativeThreadId: 'thread-cleanup' })
      first.agents.registerDriver(firstDriver)
      const original = await first.agents.create({ sessionId: SessionId('resident-cleanup'), resident: true })
      await first.agents.restartHandoff({ generation: 'generation-cleanup' })
      const header = original.agent.session.header
      const events = original.agent.session.events
      await first.fiber.dispose()

      const second = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      await second.plugin(PreparedPersistence, { header, events })
      const adoption = await second.agents.adoptRestartHandoffs({ claimant: 'generation-without-driver' })

      expect(adoption.handles).toEqual([])
      expect(adoption.failures).toHaveLength(1)
      expect(second.agents.get(SessionId('resident-cleanup'))).toBeUndefined()
      expect(await new RestartHandoffStore({ directory }).list()).toHaveLength(1)
      await second.fiber.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains an adopted handle before completing its durable claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-retain-'))
    try {
      const first = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const firstDriver = new FakeDriver(first, 'dsh', [], undefined, { nativeThreadId: 'thread-retain' })
      first.agents.registerDriver(firstDriver)
      const original = await first.agents.create({ sessionId: SessionId('resident-retain'), resident: true })
      await first.agents.restartHandoff({ generation: 'generation-retain' })
      const header = original.agent.session.header
      const events = original.agent.session.events
      await first.fiber.dispose()

      const second = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      await second.plugin(PreparedPersistence, { header, events })
      const secondDriver = new FakeDriver(second, 'dsh', [], undefined, { nativeThreadId: 'thread-retain' })
      second.agents.registerDriver(secondDriver)
      const store = new RestartHandoffStore({ directory })
      let retained = false

      const adoption = await second.agents.adoptRestartHandoffs({
        claimant: 'generation-retain-next',
        retainHandle: (handle) => {
          retained = true
          expect(second.agents.get(handle.agent.id)).toBe(handle.agent)
          throw new Error('API owner rejected replacement handle')
        },
      })

      expect(retained).toBe(true)
      expect(adoption.handles).toEqual([])
      expect(adoption.failures).toHaveLength(1)
      expect(await store.list()).toHaveLength(1)
      expect(second.agents.get(SessionId('resident-retain'))).toBeUndefined()
      await second.fiber.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not dispose a replacement retained before a completion race settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-handoff-complete-race-'))
    try {
      const first = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const firstDriver = new FakeDriver(first, 'dsh', [], undefined, { nativeThreadId: 'thread-complete-race' })
      first.agents.registerDriver(firstDriver)
      const original = await first.agents.create({ sessionId: SessionId('resident-complete-race'), resident: true })
      await first.agents.restartHandoff({ generation: 'generation-complete-race' })
      const header = original.agent.session.header
      const events = original.agent.session.events
      await first.fiber.dispose()

      const second = await harness(AgentDriverId('dsh'), {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      await second.plugin(PreparedPersistence, { header, events })
      const secondDriver = new FakeDriver(second, 'dsh', [], undefined, { nativeThreadId: 'thread-complete-race' })
      second.agents.registerDriver(secondDriver)
      const store = new RestartHandoffStore({ directory })
      const retained: AgentHandle[] = []

      // Replace completion after claim so ownership has transferred before the
      // durable race is observed; the retained replacement must remain live.
      const complete = vi.spyOn(RestartHandoffStore.prototype, 'complete')
        .mockRejectedValueOnce(new Error('completion raced'))
      const adoption = await second.agents.adoptRestartHandoffs({
        claimant: 'generation-complete-race-next',
        retainHandle: (handle) => { retained.push(handle) },
      })
      complete.mockRestore()

      expect(adoption.handles).toEqual([])
      expect(adoption.failures).toHaveLength(1)
      expect(retained).toHaveLength(1)
      expect(second.agents.get(SessionId('resident-complete-race'))).toBe(retained[0]?.agent)
      expect(secondDriver.disposeCalls).toBe(0)
      // The claim remains fenced with the retained replacement instead of
      // allowing another generation to double-adopt the same Session.
      const claimed = (await store.list())[0]
      expect(claimed).toBeDefined()
      await expect(store.claim(claimed!, 'generation-complete-race-other')).rejects.toThrow(
        'claimed by another generation',
      )
      await retained[0]!.dispose()
      await second.fiber.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
