import type { AgentDriverId, ModelSelection, Session } from '@deepseek-ai/dsh-session'
import type { Agent, AgentOptions, SessionStartSource } from './runtime-types.ts'
import type { AgentDriverHandoff, AgentHandoffRecord } from './handoff.ts'

export type { AgentDriverHandoff, AgentHandoffRecord } from './handoff.ts'

/** Stable id of the built-in DSH loop Driver. */
export const DSH_AGENT_DRIVER_ID = 'dsh' as AgentDriverId

/** Immutable discovery metadata for one registered Agent Driver. */
export interface AgentDriverInfo {
  /** Stable durable Driver id. */
  readonly id: AgentDriverId
  /** Human-readable Driver name. */
  readonly name: string
}

/**
 * One Driver-owned contribution advertised through the agent-neutral registry.
 * The registry does not interpret `kind` or `value`; a consumer that owns the
 * vocabulary for a contribution can discover it without adding a product
 * branch to the Agent registry or the built-in DSH loop.
 */
export interface AgentDriverContribution {
  /** Stable consumer-defined contribution key. */
  readonly id: string
  /** Driver that owns this contribution. */
  readonly driverId: AgentDriverId
  /** Consumer-defined contribution vocabulary. */
  readonly kind: string
  /** Same-process value supplied to the owning consumer. */
  readonly value: unknown
}

/**
 * One unpublished Agent prepared by an {@link AgentDriver}.
 * The registry owns publication and registry detach. The Driver hooks own
 * execution startup, quiescence, and exact prepared-scope unwind.
 */
export interface PreparedAgentDriver {
  /** The unpublished Agent over the exact prepared Session. */
  readonly agent: Agent
  /**
   * Start execution after publication and `agent/session-start` notification.
   * Input accepted during that notification must remain queued until this call.
   * @param source - whether the lifecycle is fresh or resumed.
   */
  start(source: SessionStartSource): void
  /**
   * Prepare process-generation handoff state after the Agent is idle. All
   * fallible Driver checks belong in this asynchronous phase. The returned
   * commit runs only after the generic sidecar is durable and must be an
   * infallible process-local state flip; it must not stop the Agent, detach
   * its Session, or release provider-native state.
   * @param signal - bounded restart-handoff cancellation signal.
   * @returns opaque JSON state and a post-publication commit, when supported.
   */
  handoff?(signal: AbortSignal): AgentDriverHandoff | Promise<AgentDriverHandoff>
  /** Stop execution, await quiescence, and unwind the prepared Agent scope. */
  dispose(): Promise<void>
}

/**
 * Adapter that prepares one unpublished Agent over a prepared Session.
 * Publication, setup, rollback, ownership, and teardown ordering belong to
 * {@link AgentRegistry}; implementations expose no product-specific methods.
 */
export interface AgentDriver {
  /** Immutable discovery metadata captured when the Driver is registered. */
  readonly info: AgentDriverInfo
  /**
   * Validate a durable Model Selection before a seeded Session is published
   * under this Driver. Drivers that cannot represent the selection reject the
   * lifecycle without changing the seed or falling back to another route.
   * @param selection - accepted Session intent carried by the seed.
   * @param signal - lifecycle cancellation signal, when supplied.
   * @returns settlement after target-Driver validation.
   */
  validateModelSelection?(selection: ModelSelection, signal?: AbortSignal): void | Promise<void>
  /**
   * Prepare one unpublished Agent and its private scoped context.
   * The implementation owns and unwinds every partial resource until this
   * operation resolves. It must settle promptly after `signal` aborts; a
   * resolved value transfers execution cleanup to the registry through its
   * `dispose()` hook.
   * @param session - exact unpublished prepared Session.
   * @param options - initial generic Agent options.
   * @param signal - creation lifetime cancellation and provider-unload signal.
   * @returns the unpublished Agent and narrow execution hooks.
   */
  prepare(
    session: Session,
    options: AgentOptions,
    signal: AbortSignal,
    handoff?: AgentHandoffRecord,
  ): PreparedAgentDriver | Promise<PreparedAgentDriver>
}
