/**
 * Process-local runtime status registry for durable Sessions.
 * @module @deepseek-ai/dsh-session-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { AgentDriverId, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionRuntimeActivation,
  SessionRuntimeActivationSpec,
  SessionRuntimeAttention,
  SessionRuntimeAttentionKind,
  SessionRuntimeAvailability,
  SessionRuntimeDetail,
  SessionRuntimeOperation,
  SessionRuntimeStatus,
  SessionRuntimeUnavailableReason,
} from './types.ts'

export type * from './types.ts'

/** One exact exclusive activation contribution. */
interface ActivationContribution {
  readonly token: object
  availability: Extract<SessionRuntimeAvailability, { kind: 'activating' | 'unavailable' }>
  operation: SessionRuntimeOperation
  detail: SessionRuntimeDetail | undefined
}

/** Mutable sources used to derive one immutable current value. */
interface RuntimeEntry {
  readonly sessionId: SessionId
  readonly driverId: AgentDriverId
  baseline: Extract<SessionRuntimeAvailability, { kind: 'cold' | 'unavailable' }>
  activation: ActivationContribution | undefined
  agent: Agent | undefined
  activity: AgentStatus | undefined
  readonly approvals: Set<object>
  readonly userInputs: Set<object>
  status: SessionRuntimeStatus
}

/** Semantic fields compared before a revision is committed. */
type RuntimeSemanticStatus = Omit<SessionRuntimeStatus, 'revision' | 'updatedAt'>

/** Require a non-empty user-facing or protocol label without silently rewriting it. */
function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

/** Detach and freeze one Driver-owned detail value. */
function snapshotDetail(detail: SessionRuntimeDetail | undefined): SessionRuntimeDetail | undefined {
  if (detail === undefined) return undefined
  const kind = nonEmpty(detail.kind, 'session runtime detail kind')
  const data = snapshotJsonValue(detail.data)
  if (data === undefined) throw new TypeError('session runtime detail data must be lossless JSON')
  return deepFreeze({ kind, data })
}

/** Validate and detach one unavailable diagnosis. */
function snapshotReason(reason: SessionRuntimeUnavailableReason): SessionRuntimeUnavailableReason {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reason.code)) {
    throw new TypeError('session runtime unavailable reason code must be lower-kebab-case')
  }
  const message = nonEmpty(reason.message, 'session runtime unavailable reason message')
  if (typeof reason.retryable !== 'boolean') {
    throw new TypeError('session runtime unavailable reason retryable must be boolean')
  }
  return deepFreeze({ code: reason.code, message, retryable: reason.retryable })
}

/** Validate one merge-extensible operation label. */
function operation(value: SessionRuntimeOperation | undefined): SessionRuntimeOperation {
  return nonEmpty(value ?? 'conversation', 'session runtime operation') as SessionRuntimeOperation
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionRuntimes: SessionRuntimeRegistry
  }

  interface Events {
    /**
     * Announces one committed process-local Session runtime value. Observer
     * failures are contained after every listener receives the value.
     * @param payload.status - new immutable current value.
     * @param payload.previous - preceding value, absent for first observation.
     * @mode emit
     */
    'session-runtime/status'(payload: {
      status: SessionRuntimeStatus
      previous?: SessionRuntimeStatus
    }): void
  }
}

/**
 * Registry of current process-local Session execution state. Durable history
 * remains in the Session log; this service reports only resources and attention
 * that exist in the current Host process.
 */
export class SessionRuntimeRegistry extends Service {
  static inject = ['agents']

  private readonly entries = new Map<SessionId, RuntimeEntry>()

  constructor(ctx: Context) {
    super(ctx, 'sessionRuntimes')
    ctx.on('agent/created', ({ agent }) => {
      const entry = this.ensureEntry(agent.session.header)
      if (entry.agent !== undefined && entry.agent !== agent) {
        throw new Error(`session runtime already tracks another live agent for "${agent.id}"`)
      }
      entry.agent = agent
      entry.activity = agent.status
      this.commit(entry)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const entry = this.ensureEntry(agent.session.header)
      if (entry.agent !== undefined && entry.agent !== agent) return
      entry.agent = agent
      entry.activity = status
      this.commit(entry)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = this.entries.get(agent.id)
      if (entry?.agent !== agent) return
      entry.agent = undefined
      entry.activity = undefined
      this.commit(entry)
    })
  }

  /**
   * Observe one durable Session header and materialize its cold current value.
   * Re-observation is idempotent and rejects an immutable Driver conflict.
   * @param header - validated durable Session header.
   * @returns the immutable current runtime value.
   */
  observe(header: SessionHeader): SessionRuntimeStatus {
    return this.ensureEntry(header).status
  }

  /**
   * Read one current runtime value.
   * @param sessionId - durable Session identity.
   * @returns the immutable current value, or `undefined` before observation.
   */
  get(sessionId: SessionId): SessionRuntimeStatus | undefined {
    return this.entries.get(sessionId)?.status
  }

  /**
   * List current values deterministically by Session id.
   * @returns a fresh array containing immutable values.
   */
  list(): SessionRuntimeStatus[] {
    return [...this.entries.values()]
      .map(entry => entry.status)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  /**
   * Begin one exclusive effect-scoped Driver activation contribution. A live
   * Agent, when published, overrides its activating or unavailable availability
   * while retaining this contribution's operation and detail.
   * @param header - exact durable Session and Driver binding.
   * @param spec - initial activating phase, operation, and Driver detail.
   * @returns the capability that alone can mutate this contribution.
   */
  begin(header: SessionHeader, spec: SessionRuntimeActivationSpec): SessionRuntimeActivation {
    const entry = this.ensureEntry(header)
    if (entry.activation !== undefined) {
      throw new Error(`session runtime activation already exists for "${header.id}"`)
    }
    const token = {}
    const contribution: ActivationContribution = {
      token,
      availability: { kind: 'activating', phase: nonEmpty(spec.phase, 'session runtime activation phase') },
      operation: operation(spec.operation),
      detail: snapshotDetail(spec.detail),
    }
    const dispose = this.ctx.effect(() => {
      entry.baseline = { kind: 'cold' }
      entry.activation = contribution
      this.commit(entry)
      return () => {
        if (entry.activation?.token !== token) return
        entry.activation = undefined
        this.commit(entry)
      }
    }, `sessionRuntimes.begin(${header.id})`)
    const current = (): ActivationContribution => {
      if (entry.activation?.token !== token) {
        throw new Error(`session runtime activation for "${header.id}" is disposed`)
      }
      return entry.activation
    }
    return {
      sessionId: header.id,
      driverId: header.driverId,
      setPhase: (phase) => {
        const active = current()
        active.availability = { kind: 'activating', phase: nonEmpty(phase, 'session runtime activation phase') }
        this.commit(entry)
      },
      setOperation: (next) => {
        current().operation = operation(next)
        this.commit(entry)
      },
      setDetail: (detail) => {
        current().detail = snapshotDetail(detail)
        this.commit(entry)
      },
      setUnavailable: (reason) => {
        current().availability = { kind: 'unavailable', reason: snapshotReason(reason) }
        this.commit(entry)
      },
      dispose: () => { void dispose() },
    }
  }

  /**
   * Record a process-local unavailable diagnosis that remains after a failed
   * activation contribution is released and is cleared by the next activation.
   * @param header - exact durable Session and Driver binding.
   * @param reason - stable diagnosis and retryability.
   */
  setUnavailable(header: SessionHeader, reason: SessionRuntimeUnavailableReason): void {
    const entry = this.ensureEntry(header)
    const availability = { kind: 'unavailable', reason: snapshotReason(reason) } as const
    entry.baseline = availability
    if (entry.activation !== undefined) entry.activation.availability = availability
    this.commit(entry)
  }

  /**
   * Clear a stored unavailable diagnosis to the cold baseline.
   * @param header - exact durable Session and Driver binding.
   */
  setCold(header: SessionHeader): void {
    const entry = this.ensureEntry(header)
    entry.baseline = { kind: 'cold' }
    this.commit(entry)
  }

  /**
   * Contribute one effect-scoped pending human-attention request. Independent
   * contributors are counted, so approvals and user-input requests can coexist.
   * @param header - exact durable Session and Driver binding.
   * @param kind - attention request category.
   * @returns exact effect disposer for this contribution.
   */
  attend(header: SessionHeader, kind: SessionRuntimeAttentionKind): () => Promise<void> | void {
    const entry = this.ensureEntry(header)
    const set = kind === 'approval' ? entry.approvals : entry.userInputs
    const token = {}
    return this.ctx.effect(() => {
      set.add(token)
      this.commit(entry)
      return () => {
        if (!set.delete(token)) return
        this.commit(entry)
      }
    }, `sessionRuntimes.attend(${header.id},${kind})`)
  }

  /**
   * Remove an unowned cold/unavailable entry when its durable Session is deleted.
   * @param sessionId - deleted durable Session identity.
   */
  forget(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    if (entry.agent !== undefined || entry.activation !== undefined
      || entry.approvals.size !== 0 || entry.userInputs.size !== 0) {
      throw new Error(`cannot forget session runtime "${sessionId}" while contributions are live`)
    }
    this.entries.delete(sessionId)
  }

  /** Find or create one immutable-header runtime entry. */
  private ensureEntry(header: SessionHeader): RuntimeEntry {
    const existing = this.entries.get(header.id)
    if (existing !== undefined) {
      if (existing.driverId !== header.driverId) {
        throw new Error(`session runtime driver conflict for "${header.id}": "${existing.driverId}" != "${header.driverId}"`)
      }
      return existing
    }
    const semantic: RuntimeSemanticStatus = {
      sessionId: header.id,
      driverId: header.driverId,
      availability: { kind: 'cold' },
      attention: { approvals: 0, userInputs: 0 },
      operation: 'conversation',
    }
    const status = deepFreeze({ ...semantic, revision: 1, updatedAt: Date.now() })
    const entry: RuntimeEntry = {
      sessionId: header.id,
      driverId: header.driverId,
      baseline: { kind: 'cold' },
      activation: undefined,
      agent: undefined,
      activity: undefined,
      approvals: new Set(),
      userInputs: new Set(),
      status,
    }
    this.entries.set(header.id, entry)
    this.emitStatus(status)
    return entry
  }

  /** Derive and commit a new immutable whole value unless the semantics are unchanged. */
  private commit(entry: RuntimeEntry): void {
    const attention: SessionRuntimeAttention = {
      approvals: entry.approvals.size,
      userInputs: entry.userInputs.size,
    }
    const availability: SessionRuntimeAvailability = entry.agent === undefined
      ? entry.activation?.availability ?? entry.baseline
      : { kind: 'available' }
    const semantic: RuntimeSemanticStatus = {
      sessionId: entry.sessionId,
      driverId: entry.driverId,
      availability,
      ...entry.agent === undefined ? {} : { activity: entry.activity ?? entry.agent.status },
      attention,
      operation: entry.activation?.operation ?? 'conversation',
      ...entry.activation?.detail === undefined ? {} : { detail: entry.activation.detail },
    }
    const previousSemantic: RuntimeSemanticStatus = {
      sessionId: entry.status.sessionId,
      driverId: entry.status.driverId,
      availability: entry.status.availability,
      ...entry.status.activity === undefined ? {} : { activity: entry.status.activity },
      attention: entry.status.attention,
      operation: entry.status.operation,
      ...entry.status.detail === undefined ? {} : { detail: entry.status.detail },
    }
    if (isDeepStrictEqual(semantic, previousSemantic)) return
    const previous = entry.status
    entry.status = deepFreeze({
      ...semantic,
      revision: previous.revision + 1,
      updatedAt: Date.now(),
    })
    this.emitStatus(entry.status, previous)
  }

  /** Contain ordinary status observers while preserving invariant failures. */
  private emitStatus(status: SessionRuntimeStatus, previous?: SessionRuntimeStatus): void {
    let invariantFailure: unknown
    const payload = previous === undefined ? { status } : { status, previous }
    const args = ['session-runtime/status', payload]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(value: typeof payload) => unknown>) {
      try {
        const returned = listener(payload)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`session runtime observer rejected: ${String(error)}`)
          })
        }
      } catch (error: unknown) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') invariantFailure ??= error
        else this.ctx.logger.warn(`session runtime observer threw: ${String(error)}`)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
}

export default SessionRuntimeRegistry
