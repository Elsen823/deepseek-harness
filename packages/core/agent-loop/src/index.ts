/**
 * Concrete agent-loop plugin: creates scoped ReactLoopAgents, publishes them
 * through the agent/session registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { DSH_AGENT_DRIVER_ID } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentDriver,
  AgentDriverInfo,
  AgentOptions,
  PreparedAgentDriver,
} from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ReactLoopAgent } from './agent.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Resolve the deployment-wide scheduler cap at the owning config boundary. */
function resolveMaxParallelToolCalls(value: number | undefined): number {
  const maxParallelToolCalls = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return maxParallelToolCalls
}

/** Reject an output-token cap that cannot be represented exactly on the request wire. */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config `id` and set with `ctx.provide()` before any Loader
     * entry mounts (see {@link CONFIGURED_AGENT_IDENTITIES_KEY}). A launcher
     * owns identity because only it knows whether the session already exists,
     * while the `cordis.yml` row keeps the model route as ordinary patchable
     * config. An entry with no matching key keeps its configured identity.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * Consumers that buffer work for the configured identity use this
     * transient signal to reject that work instead of waiting forever. Normal
     * Driver teardown suppresses failures from the cancelled startup attempt.
     * @param payload.sessionId - exact shared agent/session identity that failed startup.
     * @param payload.error - persistence, setup, or publication failure.
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/**
 * One launcher-selected session identity for a configured agent. `resume`
 * distinguishes rehydrating existing persisted history from creating the
 * session fresh under that exact id, which the two config keys express as
 * `resumeSessionId` and `sessionId`.
 */
export interface LauncherAgentIdentity {
  /** Exact session id to create fresh or resume. */
  id: SessionId
  /** Resume existing persisted history instead of creating the session fresh. */
  resume: boolean
}

/** Launcher-selected identities keyed by the configured agent's `id`. */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`) to fix
 * configured agents' session identities without a config key, so an overlay
 * repointing the row's model route cannot drop them.
 */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * Apply launcher-owned identities over the configured agents, replacing both
 * identity keys for every entry the launcher named so a config-supplied
 * identity can never survive alongside a launcher-supplied one.
 * @param agents - the configured agent entries.
 * @param identities - launcher identities keyed by configured agent `id`, or `undefined`.
 * @returns the entries with launcher-owned identities applied.
 */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Settings namespace carrying the tool-call parallelism a user owns. */
export const AGENT_LOOP_SETTINGS_NAMESPACE = settingsNamespace('agent-loop')

/**
 * The agent-loop fields a user owns. Deliberately a strict subset of
 * {@link Config}: `agents` is a boot-time composition array consumed once when
 * the service starts, so a stored change could only look like it had an effect.
 */
export interface AgentLoopSettings {
  /** Maximum parallel-safe calls in flight per agent step. */
  maxParallelToolCalls: number
}

/** Schema of the agent-loop settings section. */
export const AGENT_LOOP_SETTINGS_SCHEMA: z<AgentLoopSettings> = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
})

/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls?: number
  /** Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}

/** Agent-loop configuration after defaults and load-time validation. */
type ResolvedConfig = Config & { maxParallelToolCalls: number }

/** Reject self-contained identity conflicts before any configured agent starts. */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/** Package-private built-in Driver adapter over ReactLoopAgent. */
class DshAgentDriver implements AgentDriver {
  readonly info: AgentDriverInfo = Object.freeze({
    id: DSH_AGENT_DRIVER_ID,
    name: 'DeepSeek Harness',
  })

  constructor(private readonly ctx: Context) {}

  prepare(session: Session, options: AgentOptions, signal: AbortSignal): PreparedAgentDriver {
    assertAgentOptions(options)
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(`agent "${session.id}" creation aborted`, { cause: signal.reason })
    }
    const agent = new ReactLoopAgent(this.ctx, session.id, options, session)
    return {
      agent,
      start: () => {},
      dispose: async () => {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await agent.scope.dispose()
      },
    }
  }
}

/** Declarative launcher and public helper for the built-in DSH Agent Driver. */
export class AgentLoop extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  /** Runtime schema for declarative agents. */
  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<Config>

  /** Validated configuration owned by the agent-loop service. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')
    const entry: AgentLoopSettings = {
      maxParallelToolCalls: resolveMaxParallelToolCalls(config.maxParallelToolCalls),
    }
    let source: () => AgentLoopSettings = () => entry
    this.config = {
      ...config,
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      // Read through on every scheduler decision: `tool-calls.ts` destructures
      // this at the start of each group, so a committed change caps the next
      // group without disturbing the one in flight.
      get maxParallelToolCalls() {
        return source().maxParallelToolCalls
      },
    }
    installSettingsSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {
      // The schema admits any integer above zero; `resolveMaxParallelToolCalls`
      // owns the whole rule, so refusing here keeps the running scheduler on
      // its last good cap instead of failing at the next tool group.
      validate: value => void resolveMaxParallelToolCalls(value.maxParallelToolCalls),
      setSource: (current) => {
        source = current
      },
      // Nothing is derived from the cap: the getter above is the only reader.
      onChange: () => {},
    })
    validateConfiguredAgents(this.config.agents)
    const driver = new DshAgentDriver(ctx)
    ctx.effect(() => ctx.agents.registerDriver(driver), 'agentLoop.registerDriver()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? SessionId(`${id}-session-${randomUUID()}`)
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        const startup = persistence === undefined
          ? ctx.agents.create({
            sessionId: configuredId,
            driverId: DSH_AGENT_DRIVER_ID,
            agentOptions: options,
            meta,
          }).then(() => undefined)
          : this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta)
        void startup.catch((error: unknown) => {
          this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
        })
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void childCtx.agents.resume({
            resumeSessionId,
            agentOptions: options,
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  /** Report a contained declarative-start failure to identity-bound consumers. */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (INACTIVE_STATES.has(this.ctx.fiber.state)) return
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** Restore a materialized exact config identity on remount, or create it on first use. */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    persistence: SessionPersistence,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    try {
      await ownerCtx.agents.resume({ resumeSessionId: sessionId, agentOptions })
      return
    } catch (error: unknown) {
      if (INACTIVE_STATES.has(this.ctx.fiber.state)) return
      const exists = (await persistence.list()).some(header => header.id === sessionId)
      if (exists) throw error
    }
    await ownerCtx.agents.create({
      sessionId,
      driverId: DSH_AGENT_DRIVER_ID,
      agentOptions,
      meta,
    })
  }

  /**
   * Create one DSH-driven Agent through the generic registry.
   * @param id - shared Agent and Session identity.
   * @param options - initial loop options.
   * @param meta - optional fresh Session workspace metadata.
   * @returns the published Agent.
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    return (await this.ctx.agents.create({
      sessionId: id,
      driverId: DSH_AGENT_DRIVER_ID,
      agentOptions: options,
      meta,
    })).agent
  }
}

export default AgentLoop
