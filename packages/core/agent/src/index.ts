/**
 * Agent service: live registry, named Driver lifecycle, and process-local
 * initiator scope. Concrete execution belongs to registered Driver adapters.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isPromise } from 'node:util/types'
import z from '@deepseek-ai/schemastery'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { AgentDriverId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { DSH_AGENT_DRIVER_ID } from './driver.ts'
import type { AgentDriver, AgentDriverInfo, PreparedAgentDriver } from './driver.ts'
import { emitAgentEvent } from './dispatch.ts'
import type { Agent, AgentOptions, SessionStartSource } from './runtime-types.ts'

export * from './runtime-types.ts'
export * from './types.ts'
export * from './driver.ts'
export * from './inbox.ts'
export * from './consumed-work.ts'
export * from './model-selection.ts'
export { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    agent: TypertContext<SessionId>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
    /**
     * The agent association installed as an own property on `Agent.ctx`, or
     * `undefined` on a plain context. Contexts derived from `Agent.ctx` inherit
     * the association; a deliberately nested scope may carry a nearer
     * `dsh-scope` tag while retaining it, so this field is DX context rather
     * than the scope resolver. {@link AgentRegistry} registers a root accessor
     * defaulting to `undefined`, and core packages below the agent layer use
     * `scopeOf()` for layer selection instead of reading this field.
     */
    agent?: Agent
  }
}

/**
 * Synchronous finalizer returned by unpublished Agent setup when its
 * contributions need validation at the exact publication commit point.
 */
export interface AgentSetupCommit {
  /**
   * Validate and commit the prepared setup immediately before publication.
   * @throws when publication must roll the unpublished Agent back.
   */
  commit(): void
}

/**
 * Compose an unpublished Agent scope and optionally return its publication commit.
 * @param agentCtx - unpublished Agent scope.
 * @returns an optional synchronous commit invoked after setup awaits settle and immediately before publication.
 */
export type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/**
 * Options for programmatically creating an agent through the Driver registry
 * ({@link AgentRegistry.create}). The caller supplies the single live
 * `sessionId` shared by the agent registry and session log (e.g. an
 * ACP-generated id), plus optional session metadata (the validated `cwd`, fork
 * lineage); the registry creates the session and agent under that identity.
 */
export interface CreateAgentOptions {
  /** The live agent/session identity. */
  readonly sessionId: SessionId
  /** Agent Driver to bind durably; omission uses the registry default. */
  readonly driverId?: AgentDriverId
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, the `seedLength` seed boundary, the coarse `origin`
   * classification, and the `delegationDepth` recursion budget. Mirrors the
   * `cwd`/`parentSession`/`seedLength`/`origin`/`delegationDepth` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it). This is durable session data,
   * so the session boundary validates and snapshots it before asynchronous
   * setup begins.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  /**
   * Initial replay/fork history. A fork supplies a balanced completed-turn
   * prefix of the parent's log. The complete seed must be contiguous from seq
   * 0, carry only lossless-JSON data, and contain no open turn/step or dangling
   * tool call. The factory passes it to the session's durable
   * validator/snapshot boundary before publication.
   */
  readonly seed?: readonly SessionEvent[]
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  readonly signal?: AbortSignal
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx` but BEFORE inserting or announcing either
   * the session or agent, so observers can never see a partially configured
   * world. Setup may return an {@link AgentSetupCommit}; the registry invokes its
   * synchronous `commit()` after every setup await settles and immediately
   * before registry publication. This lets mutable provisioning revalidate at
   * the exact publication boundary. Everything registered through `agentCtx`
   * (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited
   * child plugins) exists before `session/created`, `agent/created`,
   * `agent/session-start`, and the first prompt assembly. A setup
   * throw/rejection, commit throw, or owner disposal rolls the scope back
   * without publishing either id.
   *
   * **Setup composes, it never drives**: the callback is trusted same-process
   * code and receives the full scoped context, so this is a contract rather
   * than a runtime restriction. Drive the agent only after creation resolves.
   */
  readonly setup?: AgentSetup
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The persisted session id to load and use as the live agent/session identity. */
  readonly resumeSessionId: SessionId
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  readonly signal?: AbortSignal
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the selected Driver then mints `agentCtx` and setup runs while the
   * reconstructed session and agent remain unpublished. The callback has the
   * same trusted composition-only contract and optional synchronous
   * publication commit as {@link CreateAgentOptions.setup}: all registrations
   * exist before either creation announcement, and rejection, commit failure,
   * or owner disposal rolls the transaction back without publishing either id.
   */
  readonly setup?: AgentSetup
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The exact registered Driver
 * generation is also a structural owner because the scoped Agent depends on
 * that provider; unload stops, drains, and unwinds every live handle it made
 * before detaching the Agent and Session registry entries.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/** Agent registry configuration. */
export interface Config {
  /** Driver selected for fresh Sessions whose caller omits `driverId`. */
  defaultDriverId?: AgentDriverId
}

/** Agent registry configuration after defaults. */
type ResolvedConfig = Readonly<{ defaultDriverId: AgentDriverId }>

/** Thrown when a selected Agent Driver is not registered. */
const NO_DRIVER_MESSAGE = (id: AgentDriverId): string => `no agent driver "${id}" is registered`
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/** All mutable lifecycle state for one exact registry entry. */
interface AgentEntry {
  readonly id: SessionId
  readonly agent: Agent
  /** Runtime creator-agent ownership; independent of durable session lineage. */
  readonly owner: Agent | undefined
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
}

/** One tracked boundary plus its inherited nesting chain. */
interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** Provider-owned registration state for one exact Driver generation. */
class DriverRegistration {
  readonly signal: AbortSignal
  private readonly abort = new AbortController()
  private readonly live = new Set<() => Promise<void>>()
  private readonly pending = new Set<Promise<void>>()
  private disposing: Promise<void> | undefined

  constructor(
    readonly info: AgentDriverInfo,
    readonly target: AgentDriver,
  ) {
    this.signal = this.abort.signal
  }

  /** Join one public lifecycle wrapper until every continuation settles. */
  track(job: Promise<unknown>): void {
    const settled = job.then(() => undefined, () => undefined)
    this.pending.add(settled)
    void settled.finally(() => { this.pending.delete(settled) })
  }

  /** Track one live lifecycle until its shared disposer runs. */
  trackLive(dispose: () => Promise<void>): () => void {
    this.live.add(dispose)
    return () => { this.live.delete(dispose) }
  }

  /** Abort unpublished work, quiesce live Agents, and join every wrapper admitted before drain completion. */
  dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.abort.abort(new Error(`agent driver "${this.info.id}" is not active`))
      const failures: unknown[] = []
      while (this.live.size > 0 || this.pending.size > 0) {
        const settled = await Promise.allSettled([
          ...[...this.live].map(dispose => dispose()),
          ...this.pending,
        ])
        const failed = settled.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') failures.push(failed.reason)
      }
      if (failures.length > 0) throw failures[0]
    })())
  }
}

/** Await an operation or reject promptly with one normalized abort reason. */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const abortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw abortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(abortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Start an abortable operation and release a value that resolves after cancellation. */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned: (value: T) => PromiseLike<void> | void,
  settleAbandoned?: (error?: unknown) => void,
): Promise<T> {
  if (signal.aborted) return raceAbort(Promise.resolve(undefined as never), signal, id)
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal may abort while the pending operation is awaited.
    if (signal.aborted) {
      void pending.then(
        (value) => {
          void Promise.resolve().then(() => releaseAbandoned(value)).then(
            () => { settleAbandoned?.() },
            (releaseError: unknown) => { settleAbandoned?.(releaseError) },
          )
        },
        () => { settleAbandoned?.() },
      )
    }
    throw error
  }
}

/**
 * Agent service (`ctx.agents`): tracks live agents, registered Agent Drivers,
 * and the initiating Agent through one process-local asynchronous driver chain.
 *
 * Initiator methods provide same-process causal attribution only. Ambient
 * presence is neither liveness proof nor authorization; subjects and owners
 * remain explicit, as does identity at worker, process, persistence, and wire
 * boundaries. Returned Promise boundaries drain during teardown, except a
 * nested lineage that starts an owning-fiber unload is excluded from its own drain.
 */
export class AgentRegistry extends Service {
  static Config = z.object({
    defaultDriverId: z.string().min(1).default(DSH_AGENT_DRIVER_ID),
  }) as z<Config>

  /** Validated registry configuration. */
  readonly config: ResolvedConfig
  /** Untraced provider context used for registry-owned Session and event operations. */
  private readonly runtime: { ctx: Context }
  private store = new Map<SessionId, AgentEntry>()
  private readonly drivers = new Map<AgentDriverId, DriverRegistration>()
  private readonly retirements = new Map<SessionId, Promise<void>>()
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agents')
    this.config = {
      defaultDriverId: config.defaultDriverId ?? DSH_AGENT_DRIVER_ID,
    }
    this.runtime = { ctx }
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('agent', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
      typeCtx.typert.contexts.registerHost('agent', {
        wire: 'agentId',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId)?.ctx,
      })
    })
    // The `ctx.agent` DX accessor: default `undefined` on every context, so a
    // plain plugin context reads cleanly instead of hitting the Cordis
    // unknown-property throw. Each Agent.ctx shadows it with an own property
    // (own properties resolve before the context proxy is consulted), so the
    // accessor body never needs to resolve a scope itself. Effect-scoped:
    // unwinds with this service's fiber.
    ctx.accessor('agent', { get: () => undefined })
    ctx.on('internal/status', (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    ctx.effect(function* (this: AgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), 'agents.initiatorLifecycle()')
  }

  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * Use this optional form for logging, tracing, metrics, or host attribution
   * that also supports agentless calls. When a parent creates a child, setup
   * reports the causal parent while `agentCtx.agent` identifies the child.
   * @returns the inherited Agent, or `undefined` outside an initiator boundary
   *   and inside an explicit clearing boundary.
   * @throws when this service instance has been disposed.
   */
  currentInitiator(): Agent | undefined {
    this.assertInitiatorsReadable()
    return this.initiators.getStore()
  }

  /**
   * Read the initiating Agent and fail when no initiator boundary is active.
   * Use this for private helpers contractually below a driver, or for a
   * deployment-owned outbound request whose contract forbids agentless calls.
   * Generic or direct-call paths use optional lookup or explicit request fields.
   * @returns the inherited Agent.
   * @throws when no initiator is active or this service instance has been disposed.
   */
  requireInitiator(): Agent {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /**
   * Run an operation with one exact Agent as its process-local initiator. The
   * exact synchronous value or Promise returned by the operation is preserved.
   * Custom drivers and test harnesses wrap their complete returned foreground
   * lifetime.
   * A queue or wire receiver may establish this boundary only after validating
   * explicit identity and resolving the exact live Agent; this method does neither.
   * Detached work remains owned by the subsystem that starts it.
   * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }

  /**
   * Run an operation inside a boundary that hides any inherited initiating
   * Agent. The exact synchronous value or Promise is preserved.
   * Use this while creating lazy shared timers, queue pumps, pool maintenance,
   * watchers, or exporters so they do not inherit the first Agent that happens
   * to initialize them. It clears only initiator attribution, not explicit
   * fields, and does not own or drain detached resources.
   * @param operation - synchronous or asynchronous operation to invoke without an initiator.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)
  }

  /**
   * Register one named Agent Driver as a reversible provider contribution.
   * Discovery metadata is detached, frozen, and returned in Driver-id order.
   * Provider unload aborts unpublished work, drains every live Agent prepared by
   * this generation, and only then removes the registration.
   * @param driver - Driver implementation and immutable discovery metadata.
   * @returns the exact Cordis effect disposer for the registration.
   */
  registerDriver(driver: AgentDriver): () => void {
    const dispose = this.ctx.effect(() => {
      const id = AgentDriverId(driver.info.id)
      if (this.drivers.has(id)) throw new Error(`agent driver "${id}" is already registered`)
      const target = (driver as AgentDriver & { [symbols.original]?: AgentDriver })[symbols.original] ?? driver
      const info = Object.freeze({ id, name: driver.info.name })
      const registration = new DriverRegistration(info, target)
      this.drivers.set(id, registration)
      return async () => {
        try {
          await registration.dispose()
        } finally {
          if (this.drivers.get(id) === registration) this.drivers.delete(id)
        }
      }
    }, `agents.registerDriver(${driver.info.id})`)
    // oxlint-disable-next-line typescript/no-misused-promises -- exact effect identity preserves provider teardown ordering
    return dispose
  }

  /**
   * Look up immutable discovery information for one registered Driver.
   * @param id - stable Driver id.
   * @returns a frozen detached record, or `undefined` when inactive.
   */
  getDriver(id: AgentDriverId): AgentDriverInfo | undefined {
    return this.drivers.get(id)?.info
  }

  /**
   * List registered Drivers deterministically by id.
   * @returns a fresh array of frozen discovery records.
   */
  listDrivers(): AgentDriverInfo[] {
    return [...this.drivers.values()]
      .map(registration => registration.info)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Resolve one exact Driver generation; acquisition rejects a generation already draining. */
  private requireDriver(id: AgentDriverId): DriverRegistration {
    const registration = this.drivers.get(id)
    if (registration === undefined) throw new Error(NO_DRIVER_MESSAGE(id))
    return registration
  }

  /** Wait only for a known managed same-id lifecycle already retiring. */
  private async waitForRetirement(id: SessionId, signal?: AbortSignal): Promise<void> {
    const retirement = this.retirements.get(id)
    if (retirement === undefined) return
    if (signal === undefined) await retirement
    else await raceAbort(retirement, signal, id)
  }

  /**
   * Create and publish a fresh Agent through an explicit or default Driver.
   * The selected id is written into the immutable Session header before Driver
   * preparation. The caller and Driver provider co-own the returned lifecycle.
   * @param options - shared identity, Driver selection, metadata, setup, and Agent options.
   * @returns the handle after setup, ordered publication, notification, and start.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    await this.waitForRetirement(options.sessionId, options.signal)
    const driverId = options.driverId ?? this.config.defaultDriverId
    const registration = this.requireDriver(driverId)
    const sessions = this.runtime.ctx.get('sessions')
    if (sessions === undefined) throw new Error('cannot create an agent: SessionStore is not configured')
    const preparation = SessionPreparation.create(sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      meta: {
        ...options.meta,
        driverId,
      },
    }))
    const created = this.publishPrepared(
      ownerCtx,
      registration,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'startup',
    )
    registration.track(created)
    return created
  }

  /**
   * Prepare persistence exactly once, select the Driver stored in its header,
   * and publish a resumed Agent. A caller cannot override the durable binding.
   * @param options - persisted identity, setup, cancellation, and Agent options.
   * @returns the handle after load, setup, ordered publication, notification, and start.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const ownerCtx = this.ctx
    const id = options.resumeSessionId
    await this.waitForRetirement(id, options.signal)
    const ownerAbort = new AbortController()
    const unfollowOwner = ownerCtx.effect(() => () => {
      ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
    }, `agents.resume-load(${id})`)
    const fused = AbortSignal.any([
      ...options.signal === undefined ? [] : [options.signal],
      ownerAbort.signal,
    ])
    let preparation: SessionPreparation | undefined
    try {
      preparation = await raceAbortCall(
        () => persistence.prepare(id, fused),
        fused,
        id,
        (abandoned) => { abandoned[Symbol.dispose]() },
      )
    } finally {
      await unfollowOwner()
    }
    try {
      ownerCtx.fiber.assertActive()
      const registration = this.requireDriver(preparation.session.header.driverId)
      const resumed = this.publishPrepared(
        ownerCtx,
        registration,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'resume',
      )
      registration.track(resumed)
      return await resumed
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      throw error
    }
  }

  /** Run setup and the complete publication/teardown transaction. */
  private async publishPrepared(
    ownerCtx: Context,
    registration: DriverRegistration,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    callerSignal: AbortSignal | undefined,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const id = ownedPreparation.session.id
    ownerCtx.fiber.assertActive()
    const ownerAbort = new AbortController()
    const lifecycleAbort = new AbortController()
    const relayAbort = (source: AbortSignal): void => {
      if (lifecycleAbort.signal.aborted) return
      lifecycleAbort.abort(source.reason instanceof Error
        ? source.reason
        : new Error(`agent "${id}" creation aborted`, { cause: source.reason }))
    }
    const followAbort = (source: AbortSignal | undefined): (() => void) => {
      if (source === undefined) return () => {}
      const listener = (): void => { relayAbort(source) }
      if (source.aborted) listener()
      else source.addEventListener('abort', listener, { once: true })
      return () => { source.removeEventListener('abort', listener) }
    }
    const detachCallerSignal = followAbort(callerSignal)
    const detachOwnerSignal = followAbort(ownerAbort.signal)
    const detachDriverSignal = followAbort(registration.signal)
    const fused = lifecycleAbort.signal
    const assertLive = (): void => {
      if (!fused.aborted) return
      throw fused.reason instanceof Error
        ? fused.reason
        : new Error(`agent "${id}" creation aborted`, { cause: fused.reason })
    }
    let prepared: PreparedAgentDriver | undefined
    let prepareStarted = false
    const prepareSettled = Promise.withResolvers<void>()
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let untrack = (): void => {}
    let unfollowOwner: () => Promise<void> | void = () => {}
    const dispose = (ownerTriggered = false): Promise<void> => {
      if (disposing !== undefined) return disposing
      const retirement = disposing = (async () => {
        ownerAbort.abort(new Error(`agent "${id}" lifecycle disposed`))
        try {
          if (prepareStarted && prepared === undefined) await prepareSettled.promise
          await prepared?.dispose()
        } finally {
          try {
            detachAgent?.()
            detachSession?.()
          } finally {
            detachCallerSignal()
            detachOwnerSignal()
            detachDriverSignal()
            untrack()
            if (!ownerTriggered) await unfollowOwner()
          }
        }
      })()
      this.retirements.set(id, retirement)
      const clearRetirement = (): void => {
        if (this.retirements.get(id) === retirement) this.retirements.delete(id)
      }
      void retirement.then(clearRetirement, clearRetirement)
      return retirement
    }
    untrack = registration.trackLive(dispose)
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== undefined) return
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
        return dispose(true)
      }, `agents.lifecycle(${id})`)
      const receiver = getTraceable(ownerCtx, registration.target)
      assertLive()
      prepareStarted = true
      try {
        prepared = await raceAbortCall(
          // oxlint-disable-next-line typescript/unbound-method -- receiver is deliberately caller-traced
          () => Reflect.apply(registration.target.prepare, receiver, [ownedPreparation.session, agentOptions, fused]),
          fused,
          id,
          abandoned => abandoned.dispose(),
          (error) => {
            if (error === undefined) prepareSettled.resolve()
            else prepareSettled.reject(error)
          },
        )
      } finally {
        if (prepared !== undefined || !fused.aborted) prepareSettled.resolve()
      }
      if (prepared.agent.id !== id || prepared.agent.session !== ownedPreparation.session) {
        throw new Error(`agent driver "${registration.info.id}" returned an Agent for the wrong Session`)
      }
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), fused, id)
      assertLive()
      setupCommit?.commit()
      assertLive()
      const sessions = this.runtime.ctx.get('sessions')
      if (sessions === undefined) throw new Error('cannot publish an agent: SessionStore is not configured')
      const sessionReceiver = getTraceable(prepared.agent.ctx, sessions)
      // oxlint-disable-next-line typescript/unbound-method -- receiver preserves Agent scope while using the SessionStore provider context
      detachSession = Reflect.apply(sessions.enter, sessionReceiver, [ownedPreparation.session])
      detachAgent = this.enter(prepared.agent, ownerCtx.agent)
      // oxlint-disable-next-line typescript/unbound-method -- receiver preserves Agent scope while using the SessionStore provider context
      Reflect.apply(sessions.announce, sessionReceiver, [ownedPreparation.session])
      assertLive()
      this.announce(prepared.agent)
      assertLive()
      emitAgentEvent(this.runtime.ctx, prepared.agent, 'agent/session-start', { source })
      assertLive()
      prepared.start(source)
      assertLive()
      detachCallerSignal()
      return { agent: prepared.agent, dispose }
    } catch (error: unknown) {
      await dispose()
      throw error
    }
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). Returns the disposer.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the EXACT Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      yield this.enter(agent, this.ctx.agent)
      this.announce(agent)
    }.bind(this), 'agents.register()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @param owner - live agent whose scoped context created this agent, or
   *   undefined for a top-level runtime root. This is runtime ownership, not
   *   the resumed session's durable parent lineage.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   synchronous `agent/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   */
  enter(agent: Agent, owner: Agent | undefined): () => void {
    const id = agent.id
    if (id !== agent.session.id) {
      throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
    }
    const carrier = scopeTarget(agent, agent)
    // This is the authoritative collision boundary. Concurrent create/resume
    // operations may both prepare, but only one exact entry can publish.
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const entry: AgentEntry = {
      id,
      agent,
      owner,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    this.store.set(id, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Every callback reached by this creation dispatch must observe the same
      // live entry, and disposal must follow creation. A listener may own
      // the advanced detach capability, so make that ordering structural:
      // visibility and the paired disposal are deferred until announce()'s
      // synchronous dispatch has unwound.
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // A stale capability can never delete a later same-id lifecycle. The
    // captured entry identity is the final boundary.
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, 'agent/disposed', { agent: entry.agent }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  announce(agent: Agent): void {
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    entry.announcing = true
    entry.announced = true
    const args: unknown[] = [entry.carrier, 'agent/created', { agent: entry.agent }]
    try {
      for (const callback of this.ctx.events.dispatch('emit', args)) {
        // A synchronous creation failure vetoes publication and rolls back.
        // Returned-promise rejection happens after this synchronous boundary, so
        // observe and report it instead of leaking an unhandled rejection.
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * Look up a live agent.
   * @param id - the shared agent/session id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: SessionId): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /**
   * Test whether a live agent was created through one exact parent agent's
   * scoped context. Runtime ownership is independent of durable session
   * lineage and remains unambiguous when unrelated providers reuse an id.
   * @param id - the candidate child agent's shared agent/session id.
   * @param owner - the expected runtime creator agent.
   * @returns true only while the exact child entry is live under that owner.
   */
  isOwnedBy(id: SessionId, owner: Agent): boolean {
    return this.store.get(id)?.owner === owner
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }

  /**
   * All live top-level agents in registration order. A top-level agent was
   * created without an owning agent context; durable session lineage does not
   * affect this runtime relation, so a resumed fork may still be a root.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  roots(): Agent[] {
    return [...this.store.values()]
      .filter(entry => entry.owner === undefined)
      .map(entry => entry.agent)
  }

  /** Reject new initiator boundaries while inherited continuations drain. */
  private closeInitiators(): void {
    if (this.initiatorState === 'active') this.initiatorState = 'closing'
  }

  /** Wait for returned-Promise boundaries, then invalidate retained references. */
  private disposeInitiators(): Promise<void> {
    return (this.initiatorDisposal ??= (async () => {
      this.closeInitiators()
      this.releaseReentrantInitiatorRuns()
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      this.initiatorState = 'disposed'
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  /** Establish one tracked initiator or clearing boundary. */
  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== 'active') throw new Error(DISPOSED_INITIATOR_MESSAGE)
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    this.activeInitiatorRuns += 1
    let result: T
    try {
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        // A branded Promise may expose a failing @@species. Observer setup did
        // not attach, so preserve the exact return without leaking the run.
        this.releaseInitiatorRun(run)
      }
    } else {
      this.releaseInitiatorRun(run)
    }
    return result
  }

  /** Whether one unloading fiber owns this service's lifecycle. */
  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    if (this.initiatorState === 'disposed') throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  /** Exclude the boundary chain that initiated this teardown from its own drain. */
  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

export default AgentRegistry
