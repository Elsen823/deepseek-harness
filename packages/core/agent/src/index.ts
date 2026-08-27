/**
 * Agent service: live registry, named Driver lifecycle, and process-local
 * initiator scope. Concrete execution belongs to registered Driver adapters.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isPromise } from 'node:util/types'
import z from '@deepseek-ai/schemastery'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { AgentDriverId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { DSH_AGENT_DRIVER_ID } from './driver.ts'
import type { AgentDriver, AgentDriverContribution, AgentDriverInfo, PreparedAgentDriver } from './driver.ts'
import {
  digestSession,
  digestSessionEvents,
  RestartHandoffStore,
} from './handoff.ts'
import type {
  AgentDriverHandoff,
  AgentHandoffAdoption,
  AgentHandoffFailure,
  AgentHandoffRecord,
} from './handoff.ts'
import type { ModelSelectionOwner } from './model-selection.ts'
import { emitAgentEvent } from './dispatch.ts'
import type { Agent, AgentOptions, SessionStartSource } from './runtime-types.ts'

export * from './runtime-types.ts'
export * from './types.ts'
export * from './driver.ts'
export * from './handoff.ts'
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
   * Explicitly retain this Session for a process-generation restart handoff.
   * Residency is never inferred from a Driver id or from persisted history.
   */
  readonly resident?: boolean
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
  /**
   * Explicitly retain this resumed Session for a later restart handoff. An
   * adopted handoff is resident regardless of this optional flag.
   */
  readonly resident?: boolean
  /** Exact sidecar record supplied by {@link AgentRegistry.adoptRestartHandoffs}. */
  readonly handoff?: AgentHandoffRecord
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

/** Options for one explicit process-generation restart handoff. */
export interface RestartHandoffOptions {
  /** Optional caller-selected generation id; omitted, a UUID is generated. */
  readonly generation?: string
  /** Optional cancellation for the complete bounded handoff. */
  readonly signal?: AbortSignal
}

/** Process-local restart-handoff admission state. */
export type RestartHandoffPhase = 'active' | 'requested' | 'committed'

/**
 * Raised when a process-local operation tries to enter after restart handoff
 * admission has closed. Callers should retry against the next generation.
 */
export class RestartHandoffAdmissionError extends Error {
  /**
   * @param phase - lifecycle phase that rejected the operation.
   */
  constructor(readonly phase: Exclude<RestartHandoffPhase, 'active'>) {
    super(`Agent registry is ${phase} for restart handoff`)
    this.name = 'RestartHandoffAdmissionError'
  }
}

/** Result of a committed process-generation handoff. */
export interface RestartHandoffResult {
  /** Explicit restart generation written to the sidecar. */
  readonly generation: string
  /** Resident Session records committed atomically for adoption. */
  readonly records: readonly AgentHandoffRecord[]
}

/** Options for discovering and claiming records in a new process generation. */
export interface AdoptRestartHandoffsOptions {
  /** Process-generation claimant used for stale/double-claim protection. */
  readonly claimant?: string
  /** Restrict adoption to one committed handoff generation. */
  readonly generation?: string
  /** Optional cancellation for listing, claim, and resume operations. */
  readonly signal?: AbortSignal
  /** Per-record Agent options needed by the selected Driver, when any. */
  readonly agentOptions?: (record: AgentHandoffRecord) => AgentOptions | undefined
  /** Transfer each successfully adopted handle to the next-generation owner. */
  readonly retainHandle?: (handle: AgentHandle) => void
}

/** Agent registry configuration. */
export interface Config {
  /** Driver selected for fresh Sessions whose caller omits `driverId`. */
  defaultDriverId?: AgentDriverId
  /**
   * Optional restart-handoff sidecar. Omitting this object disables restart
   * handoff; when present every field is required and validated at load time.
   */
  restartHandoff?: {
    /** Owner-only absolute directory for generation manifests. */
    directory: string
    /** Maximum time for one resident Agent to become idle and flush. */
    quiescenceTimeoutMs: number
    /** Lease duration from intent publication through next-generation adoption. */
    leaseTimeoutMs: number
  }
}

/** Agent registry configuration after defaults. */
type ResolvedConfig = Readonly<{
  defaultDriverId: AgentDriverId
  restartHandoff?: Readonly<{
    directory: string
    quiescenceTimeoutMs: number
    leaseTimeoutMs: number
  }>
}>

/** Thrown when a selected Agent Driver is not registered. */
const NO_DRIVER_MESSAGE = (id: AgentDriverId): string => `no agent driver "${id}" is registered`
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/** Reject a Driver that did not construct the required Session-local owner. */
function assertModelSelectionOwner(agent: Agent, driverId: AgentDriverId): void {
  const candidate = agent as unknown as { modelSelection?: ModelSelectionOwner }
  if (candidate.modelSelection !== undefined) return
  throw new Error(`agent driver "${driverId}" returned an Agent without a Session-local model-selection owner`)
}

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
  /** Driver generation that prepared this entry, absent for direct registration. */
  driverId: AgentDriverId | undefined
  /** Whether the caller explicitly opted this Session into restart handoff. */
  resident: boolean
  /** Driver-specific handoff preparation, absent for direct registration. */
  handoff: ((signal: AbortSignal) => Promise<AgentDriverHandoff | undefined>) | undefined
  /** True after the sidecar commit; normal disposal must then leave this entry attached. */
  handedOff: boolean
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

/** Maximum delay accepted by the Node timer used for bounded handoff. */
const MAX_HANDOFF_TIMEOUT_MS = 2_147_483_647

/** Validate a restart-handoff configuration before the service exposes it. */
function resolveRestartHandoffConfig(config: Config['restartHandoff']): ResolvedConfig['restartHandoff'] {
  if (config === undefined) return undefined
  if (config.directory.length === 0) throw new TypeError('Agent handoff directory must be non-empty')
  if (!Number.isSafeInteger(config.quiescenceTimeoutMs)
    || config.quiescenceTimeoutMs < 1
    || config.quiescenceTimeoutMs > MAX_HANDOFF_TIMEOUT_MS) {
    throw new TypeError(`Agent handoff quiescenceTimeoutMs must be an integer between 1 and ${MAX_HANDOFF_TIMEOUT_MS}`)
  }
  if (!Number.isSafeInteger(config.leaseTimeoutMs)
    || config.leaseTimeoutMs < 1
    || config.leaseTimeoutMs > MAX_HANDOFF_TIMEOUT_MS) {
    throw new TypeError(`Agent handoff leaseTimeoutMs must be an integer between 1 and ${MAX_HANDOFF_TIMEOUT_MS}`)
  }
  return Object.freeze({
    directory: config.directory,
    quiescenceTimeoutMs: config.quiescenceTimeoutMs,
    leaseTimeoutMs: config.leaseTimeoutMs,
  })
}

/** Await a handoff operation until its bounded deadline or caller cancellation. */
async function raceHandoff<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  reportedTimeoutMs = timeoutMs,
): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error(`Agent restart handoff exceeded ${reportedTimeoutMs}ms quiescence bound`))
  }, timeoutMs)
  const combined = signal === undefined
    ? timeout.signal
    : AbortSignal.any([signal, timeout.signal])
  try {
    if (combined.aborted) {
      throw combined.reason instanceof Error ? combined.reason : new Error('Agent restart handoff was cancelled')
    }
    const operationResult = Promise.resolve().then(() => operation(combined))
    // The timeout returns before a non-cooperative implementation necessarily
    // settles; observe its eventual rejection so a refused handoff cannot
    // surface as an unhandled process error.
    void operationResult.catch(() => undefined)
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.reject(combined.reason instanceof Error ? combined.reason : new Error('Agent restart handoff was cancelled'))
    }
    combined.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([operationResult, aborted.promise])
    } finally {
      combined.removeEventListener('abort', onAbort)
    }
  } finally {
    clearTimeout(timer)
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
    restartHandoff: z.object({
      directory: z.string().min(1).required(),
      quiescenceTimeoutMs: z.number().step(1).min(1).max(MAX_HANDOFF_TIMEOUT_MS).required(),
      leaseTimeoutMs: z.number().step(1).min(1).max(MAX_HANDOFF_TIMEOUT_MS).required(),
    }).default(undefined as unknown as NonNullable<Config['restartHandoff']>),
  }) as z<Config>

  /** Validated registry configuration. */
  readonly config: ResolvedConfig
  /** Untraced provider context used for registry-owned Session and event operations. */
  private readonly runtime: { ctx: Context }
  private store = new Map<SessionId, AgentEntry>()
  private readonly drivers = new Map<AgentDriverId, DriverRegistration>()
  private readonly contributions = new Map<string, AgentDriverContribution>()
  private readonly retirements = new Map<SessionId, Promise<void>>()
  private readonly handoffStore: RestartHandoffStore | undefined
  private handoffState: RestartHandoffPhase = 'active'
  private handoffPromise: Promise<RestartHandoffResult> | undefined
  /** API and other process-local operations admitted before handoff begins. */
  private restartAdmissions = 0
  /** Barrier resolved when every pre-handoff operation has settled. */
  private restartAdmissionDrain: PromiseWithResolvers<void> | undefined
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agents')
    const restartHandoff = resolveRestartHandoffConfig(config.restartHandoff)
    this.config = {
      defaultDriverId: config.defaultDriverId ?? DSH_AGENT_DRIVER_ID,
      ...(restartHandoff === undefined ? {} : { restartHandoff }),
    }
    this.handoffStore = restartHandoff === undefined
      ? undefined
      : new RestartHandoffStore({ directory: restartHandoff.directory })
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

  /** Current process-generation admission phase for restart handoff. */
  get restartHandoffPhase(): RestartHandoffPhase {
    return this.handoffState
  }

  /**
   * Admit one process-local operation before a restart handoff closes the
   * generation. The returned idempotent release must run after the complete
   * asynchronous operation settles; handoff waits for every admitted release.
   *
   * @returns a release callback for the admitted operation.
   * @throws {@link RestartHandoffAdmissionError} after admission closes.
   */
  admitRestartOperation(): () => void {
    if (this.handoffState !== 'active') {
      throw new RestartHandoffAdmissionError(this.handoffState)
    }
    this.restartAdmissions += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.restartAdmissions -= 1
      if (this.restartAdmissions === 0) {
        this.restartAdmissionDrain?.resolve()
        this.restartAdmissionDrain = undefined
      }
    }
  }

  /** Wait for operations admitted before the restart intent to settle. */
  private async waitForRestartAdmissions(): Promise<void> {
    if (this.restartAdmissions === 0) return
    const drain = this.restartAdmissionDrain ??= Promise.withResolvers<void>()
    if (this.restartAdmissions === 0) {
      drain.resolve()
      this.restartAdmissionDrain = undefined
      return
    }
    await drain.promise
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
  registerDriver(driver: AgentDriver): () => Promise<void> {
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
          for (const [key, contribution] of this.contributions) {
            if (contribution.driverId === id) this.contributions.delete(key)
          }
        }
      }
    }, `agents.registerDriver(${driver.info.id})`)
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

  /**
   * Register one consumer-defined contribution owned by an Agent Driver.
   * Contributions are deliberately opaque to this service: the Agent layer
   * only provides effect-scoped storage and deterministic discovery, leaving
   * settings, management, and presentation vocabularies to their consumers.
   * @param contribution - stable key, owning Driver, and consumer value.
   * @returns a synchronous disposer that removes the contribution.
   */
  registerDriverContribution(contribution: AgentDriverContribution): () => void {
    const driverId = AgentDriverId(contribution.driverId)
    if (contribution.id.length === 0) throw new TypeError('Agent Driver contribution id must be non-empty')
    if (contribution.kind.length === 0) throw new TypeError('Agent Driver contribution kind must be non-empty')
    const key = `${driverId}:${contribution.id}`
    const detached = Object.freeze({ ...contribution, driverId })
    const dispose = this.ctx.effect(() => {
      if (this.contributions.has(key)) {
        throw new Error(`Agent Driver contribution "${key}" is already registered`)
      }
      this.contributions.set(key, detached)
      return () => {
        if (this.contributions.get(key) === detached) this.contributions.delete(key)
      }
    }, `agents.registerDriverContribution(${key})`)
    return () => { void dispose() }
  }

  /**
   * List opaque Driver contributions in stable key order.
   * @param driverId - optional Driver filter.
   * @returns detached contribution records owned by active Driver providers.
   */
  listDriverContributions(driverId?: AgentDriverId): AgentDriverContribution[] {
    return [...this.contributions.values()]
      .filter(contribution => driverId === undefined || contribution.driverId === driverId)
      .sort((left, right) => `${left.driverId}:${left.id}`.localeCompare(`${right.driverId}:${right.id}`))
  }

  /** Reject ordinary lifecycle admission while this generation owns restart handoff. */
  private assertHandoffAdmission(handoff?: AgentHandoffRecord): void {
    if (this.handoffState === 'active') return
    if (handoff !== undefined && this.handoffState === 'requested') {
      throw new Error('Agent restart handoff is still being prepared in this generation')
    }
    throw new Error(`Agent registry is ${this.handoffState} for restart handoff`)
  }

  /** Validate sidecar identity against the exact Session loaded by persistence. */
  private assertHandoffRecord(session: Session, record: AgentHandoffRecord | undefined): void {
    if (record === undefined) return
    if (record.sessionId !== session.id) {
      throw new Error(`Agent handoff Session mismatch: expected "${record.sessionId}", got "${session.id}"`)
    }
    if (record.driverId !== session.header.driverId) {
      throw new Error(`Agent handoff Driver mismatch for "${session.id}": expected "${record.driverId}", got "${session.header.driverId}"`)
    }
    // Persistence preparation may append a process-local `session/end-seed`
    // marker after the stored prefix. The marker is not part of the sidecar's
    // identity, so validate the exact recorded prefix while requiring the
    // Session's first-live watermark to name that same prefix. A digest-only
    // check would accept a stale checkpoint whose prefix happened to match.
    const durablePrefix = session.events.slice(0, record.eventSeq)
    if (session.firstLiveSeq !== record.eventSeq
      || durablePrefix.length !== record.eventSeq
      || record.eventDigest !== digestSessionEvents(durablePrefix)) {
      throw new Error(`Agent handoff Session "${session.id}" changed after its durable checkpoint (firstLiveSeq ${String(session.firstLiveSeq)}, expected ${String(record.eventSeq)})`)
    }
  }

  /**
   * Quiesce explicitly resident Agents and atomically publish a next-generation
   * adoption manifest. Ordinary provider unload and Agent disposal retain their
   * existing semantics; this method is the only restart handoff entry point.
   * @param options - explicit generation and cancellation values.
   * @returns the committed generation and its resident Session records.
   */
  async restartHandoff(options: RestartHandoffOptions = {}): Promise<RestartHandoffResult> {
    if (this.handoffStore === undefined || this.config.restartHandoff === undefined) {
      throw new Error('Agent restart handoff is not configured')
    }
    if (this.handoffPromise !== undefined) return this.handoffPromise
    if (this.handoffState !== 'active') throw new RestartHandoffAdmissionError(this.handoffState)
    const generation = options.generation ?? randomUUID()
    this.handoffState = 'requested'
    this.handoffPromise = this.performRestartHandoff(generation, options)
    try {
      return await this.handoffPromise
    } catch (error: unknown) {
      this.handoffPromise = undefined
      // Publication is a one-way boundary. A Driver commit is required to be
      // infallible; if an implementation violates that requirement, retain a
      // committed failure state so no later call can reopen the old generation
      // over a durable adoption manifest.
      if (this.restartHandoffPhase !== 'committed') this.handoffState = 'active'
      throw error
    }
  }

  /** Execute one explicit restart handoff after intent publication. */
  private async performRestartHandoff(
    generation: string,
    options: RestartHandoffOptions,
  ): Promise<RestartHandoffResult> {
    const store = this.handoffStore
    const config = this.config.restartHandoff
    /* v8 ignore next -- guarded by restartHandoff() before this private path. */
    if (store === undefined || config === undefined) throw new Error('Agent restart handoff is not configured')
    const leaseExpiresAt = Date.now() + config.leaseTimeoutMs
    await store.begin(generation, leaseExpiresAt)
    try {
      const deadline = Date.now() + config.quiescenceTimeoutMs
      const withinBound = <T>(operation: (signal: AbortSignal) => PromiseLike<T> | T): Promise<T> => {
        const remaining = deadline - Date.now()
        if (remaining < 1) {
          return Promise.reject(new Error(`Agent restart handoff exceeded ${config.quiescenceTimeoutMs}ms quiescence bound`))
        }
        return raceHandoff(operation, remaining, options.signal, config.quiescenceTimeoutMs)
      }
      await withinBound(() => this.waitForRestartAdmissions())
      const residents = [...this.store.values()].filter(entry => entry.resident && !entry.handedOff)
      const sessions = this.runtime.ctx.get('sessions')
      if (sessions === undefined) throw new Error('cannot handoff Agents: SessionStore is not configured')
      const prepared: Array<{ readonly entry: AgentEntry; readonly handoff: AgentDriverHandoff; readonly record: AgentHandoffRecord }> = []
      for (const entry of residents) {
        const entryHandoff = entry.handoff
        if (entryHandoff === undefined) throw new Error(`Agent Driver for "${entry.id}" does not support restart handoff`)
        const operation = async (
          handoffSignal: AbortSignal,
        ): Promise<{ readonly handoff: AgentDriverHandoff; readonly record: AgentHandoffRecord }> => {
          await raceAbort(entry.agent.whenIdle(), handoffSignal, entry.id)
          handoffSignal.throwIfAborted()
          await raceAbort(sessions.flush(entry.agent.session), handoffSignal, entry.id)
          handoffSignal.throwIfAborted()
          const eventSeq = entry.agent.session.events.length
          const eventDigest = digestSession(entry.agent.session)
          const handoff = await entryHandoff(handoffSignal)
          handoffSignal.throwIfAborted()
          if (handoff === undefined) throw new Error(`Agent Driver for "${entry.id}" returned no handoff state`)
          if (eventSeq !== entry.agent.session.events.length || eventDigest !== digestSession(entry.agent.session)) {
            throw new Error(`Agent "${entry.id}" changed its Session during restart handoff`)
          }
          const record: AgentHandoffRecord = Object.freeze({
            version: 1,
            generation,
            resident: true,
            sessionId: entry.id,
            driverId: entry.driverId ?? entry.agent.session.header.driverId,
            eventSeq,
            eventDigest,
            leaseExpiresAt,
            ...(handoff.state === undefined ? {} : { state: handoff.state }),
          })
          return { handoff, record }
        }
        const result = await withinBound(operation)
        prepared.push({ entry, ...result })
      }
      await store.publish(generation, prepared.map(item => item.record))
      // The sidecar is now the source of truth for the next generation. Fence
      // every old entry before invoking Driver commits so even a violating
      // throwing commit cannot send ordinary disposal through the old entry.
      this.handoffState = 'committed'
      for (const item of prepared) item.entry.handedOff = true
      const commitFailures: unknown[] = []
      for (const item of prepared) {
        try {
          item.handoff.commit()
        } catch (error: unknown) {
          commitFailures.push(error)
        }
      }
      if (commitFailures.length > 0) {
        throw new AggregateError(commitFailures, 'Agent restart handoff Driver commit failed after publication')
      }
      return Object.freeze({ generation, records: prepared.map(item => item.record) })
    } catch (error: unknown) {
      if (this.handoffState === 'committed') throw error
      this.handoffState = 'active'
      try {
        await store.reject(generation, error instanceof Error ? error.message : String(error))
      } catch (rejectError: unknown) {
        throw new AggregateError([error, rejectError], 'Agent restart handoff was rejected but its intent could not be marked rejected')
      }
      throw error
    }
  }

  /**
   * Discover and adopt only resident Sessions explicitly committed by a prior
   * generation. Failed claims are released for retry and never dispose a
   * replacement Agent or delete the native Driver state.
   * @param options - claimant, generation filter, cancellation, and Driver options.
   * @returns successful handles plus records whose adoption remains retryable.
   */
  async adoptRestartHandoffs(options: AdoptRestartHandoffsOptions = {}): Promise<AgentHandoffAdoption<AgentHandle>> {
    if (this.handoffStore === undefined) throw new Error('Agent restart handoff is not configured')
    const claimant = options.claimant ?? randomUUID()
    const candidates = (await this.handoffStore.list())
      .filter(record => options.generation === undefined || record.generation === options.generation)
    const handles: AgentHandle[] = []
    const failures: AgentHandoffFailure[] = []
    for (const candidate of candidates) {
      options.signal?.throwIfAborted()
      let claimed: AgentHandoffRecord | undefined
      let handle: AgentHandle | undefined
      let claimCompleted = false
      let retained = false
      try {
        claimed = await this.handoffStore.claim(candidate, claimant)
        const agentOptions = options.agentOptions?.(claimed)
        handle = await this.resume({
          resumeSessionId: claimed.sessionId,
          resident: true,
          handoff: claimed,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
        if (options.retainHandle === undefined) retained = true
        else {
          options.retainHandle(handle)
          retained = true
        }
        // Transfer the process-local owner before marking the durable claim
        // complete. If retention rejects, release() keeps the record
        // retryable; completing first could leave a replacement Agent without
        // an owner while making the native Session unavailable to every later
        // generation.
        await this.handoffStore.complete(claimed, claimant)
        claimCompleted = true
        handles.push(handle)
      } catch (error: unknown) {
        const cleanupErrors: unknown[] = []
        // Retention transfers the process-local owner before completion. Once
        // that transfer succeeds it cannot be rolled back by this registry:
        // keep the replacement Agent and its claim fenced rather than
        // releasing an Agent that the API generation may already be serving.
        if (handle !== undefined && !retained) {
          try {
            await handle.dispose()
          } catch (disposeError: unknown) {
            cleanupErrors.push(disposeError)
          }
        }
        if (claimed !== undefined && !claimCompleted && !retained) {
          try {
            await this.handoffStore.release(claimed, claimant)
          } catch (releaseError: unknown) {
            cleanupErrors.push(releaseError)
          }
        }
        failures.push({
          record: candidate,
          error: cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors], 'Agent handoff adoption cleanup failed'),
        })
      }
    }
    return Object.freeze({ handles, failures })
  }

  /** Resolve one exact Driver generation; acquisition rejects a generation already draining. */
  private requireDriver(id: AgentDriverId): DriverRegistration {
    const registration = this.drivers.get(id)
    if (registration === undefined) throw new Error(NO_DRIVER_MESSAGE(id))
    return registration
  }

  /** Validate a seeded Session intent against the target Driver before publication. */
  private async validatePreparedSelection(
    registration: DriverRegistration,
    session: Session,
    signal?: AbortSignal,
  ): Promise<void> {
    const selection = session.modelSelection()
    if (selection === undefined) return
    await registration.target.validateModelSelection?.({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }, signal)
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
    this.assertHandoffAdmission()
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
    try {
      await this.validatePreparedSelection(registration, preparation.session, options.signal)
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      throw error
    }
    const created = this.publishPrepared(
      ownerCtx,
      registration,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'startup',
      options.resident === true,
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
    this.assertHandoffAdmission(options.handoff)
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
      this.assertHandoffRecord(preparation.session, options.handoff)
      await this.validatePreparedSelection(registration, preparation.session, options.signal)
      const resumed = this.publishPrepared(
        ownerCtx,
        registration,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'resume',
        options.resident === true || options.handoff !== undefined,
        options.handoff,
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
    resident: boolean,
    handoff?: AgentHandoffRecord,
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
    let handoffCommitted = false
    let untrack = (): void => {}
    let unfollowOwner: () => Promise<void> | void = () => {}
    const dispose = (ownerTriggered = false): Promise<void> => {
      if (disposing !== undefined) return disposing
      const retirement = disposing = (async () => {
        if (handoffCommitted) {
          // The process-generation handoff has already published durable
          // adoption state. Normal owner/provider disposal must not call the
          // Driver hook or emit either ordinary lifecycle edge afterward.
          detachCallerSignal()
          detachOwnerSignal()
          detachDriverSignal()
          untrack()
          if (!ownerTriggered) await unfollowOwner()
          return
        }
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
          () => Reflect.apply(registration.target.prepare, receiver, [ownedPreparation.session, agentOptions, fused, handoff]),
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
      assertModelSelectionOwner(prepared.agent, registration.info.id)
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), fused, id)
      assertLive()
      setupCommit?.commit()
      assertLive()
      const sessions = this.runtime.ctx.get('sessions')
      if (sessions === undefined) throw new Error('cannot publish an agent: SessionStore is not configured')
      this.assertHandoffAdmission(handoff)
      const sessionReceiver = getTraceable(prepared.agent.ctx, sessions)
      // oxlint-disable-next-line typescript/unbound-method -- receiver preserves Agent scope while using the SessionStore provider context
      detachSession = Reflect.apply(sessions.enter, sessionReceiver, [ownedPreparation.session])
      detachAgent = this.enter(prepared.agent, ownerCtx.agent)
      this.configureManagedEntry(prepared.agent, {
        driverId: registration.info.id,
        resident,
        handoff: async signal => prepared?.handoff === undefined
          ? undefined
          : await prepared.handoff(signal),
        commitHandoff: () => { handoffCommitted = true },
      })
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
    assertModelSelectionOwner(agent, agent.session.header.driverId)
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
      driverId: undefined,
      resident: false,
      handoff: undefined,
      handedOff: false,
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

  /** Attach the private managed lifecycle to an already-entered Driver Agent. */
  private configureManagedEntry(
    agent: Agent,
    options: {
      readonly driverId: AgentDriverId
      readonly resident: boolean
      readonly handoff: (signal: AbortSignal) => Promise<AgentDriverHandoff | undefined>
      readonly commitHandoff: () => void
    },
  ): void {
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) throw new Error(`agent "${agent.id}" is not live in this registry`)
    entry.driverId = options.driverId
    entry.resident = options.resident
    entry.handoff = options.handoff
    const originalHandoff = entry.handoff
    entry.handoff = async (signal) => {
      const prepared = await originalHandoff(signal)
      if (prepared === undefined) return undefined
      return {
        ...prepared,
        commit: () => {
          options.commitHandoff()
          prepared.commit()
        },
      }
    }
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
