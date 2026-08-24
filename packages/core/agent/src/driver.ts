import type { AgentDriverId, Session } from '@deepseek-ai/dsh-session'
import type { Agent, AgentOptions, SessionStartSource } from './runtime-types.ts'

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
  ): PreparedAgentDriver | Promise<PreparedAgentDriver>
}
