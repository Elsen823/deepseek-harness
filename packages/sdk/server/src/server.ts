/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { AgentDriverId, SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-runtime'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  AgentDriverCatalogResult,
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionCreatedNotification,
  SessionEventNotification,
  SessionRuntimeParams,
  SessionRuntimeResult,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  driverId: ReturnType<typeof AgentDriverId>
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private defaultDriverId = AgentDriverId('dsh')
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.defaultDriverId = ctx.agents.config.defaultDriverId
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session-runtime/status', ({ status }) => {
      this.transport.notify('session.runtime', { status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      const created: SessionCreatedNotification = {
        sessionId: String(session.id),
        driverId: String(session.header.driverId),
        ...parentSession === undefined ? {} : { parentSessionId: String(parentSession) },
      }
      this.transport.notify('session.created', created)
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const driverId = params.driverId === undefined
      ? this.ctx.agents.config.defaultDriverId
      : AgentDriverId(params.driverId)
    if (this.ctx.agents.getDriver(driverId) === undefined) {
      throw new Error(`no Agent Driver registered for "${driverId}"`)
    }
    this.defaultDriverId = driverId
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      drivers: this.driverCatalog(),
    }
  }

  /**
   * Return the current active Driver catalog.
   * @returns the configured default and active Driver registrations.
   */
  drivers(): AgentDriverCatalogResult {
    return this.driverCatalog()
  }

  /**
   * Return one process-local Session runtime value without activating it.
   * @param params - durable Session identity.
   * @returns the current runtime value, or `null` when no durable Session has this id.
   */
  async runtime(params: SessionRuntimeParams): Promise<SessionRuntimeResult> {
    const id = SessionId(params.sessionId)
    const runtimes = this.ctx.get('sessionRuntimes')
    const current = runtimes?.get(id)
    if (current !== undefined) return { status: current }
    const attached: SessionStore | undefined = this.ctx.get('sessions')
    const attachedSession = attached?.get(id)
    if (attachedSession !== undefined) return { status: runtimes?.observe(attachedSession.header) ?? null }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return { status: null }
    const header = (await persistence.list()).find((candidate: SessionHeader) => candidate.id === id)
    return { status: header === undefined ? null : runtimes?.observe(header) ?? null }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const driverId = params.driverId === undefined ? this.defaultDriverId : AgentDriverId(params.driverId)
    const rec = await this.getOrCreateSession(params.sessionId, driverId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'agent/drivers':
        return this.drivers()
      case 'session/runtime':
        return this.runtime(params as unknown as SessionRuntimeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(
    sessionId: string,
    driverId: ReturnType<typeof AgentDriverId>,
  ): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (this.ctx.agents.getDriver(driverId) === undefined) {
      throw new Error(`no Agent Driver registered for "${driverId}"`)
    }
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.assertDriver(sessionId, driverId, existing.driverId)
      return existing
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending !== undefined) {
      const record = await pending
      this.assertDriver(sessionId, driverId, record.driverId)
      return record
    }
    const creation = this.createSession(sessionId, driverId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(
    sessionId: string,
    driverId: ReturnType<typeof AgentDriverId>,
  ): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      driverId,
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle, driverId }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private driverCatalog(): AgentDriverCatalogResult {
    return {
      defaultId: String(this.defaultDriverId),
      items: this.ctx.agents.listDrivers().map(driver => ({ id: String(driver.id), name: driver.name })),
    }
  }

  private assertDriver(
    sessionId: string,
    requested: ReturnType<typeof AgentDriverId>,
    existing: ReturnType<typeof AgentDriverId>,
  ): void {
    if (requested === existing) return
    throw new Error(
      `session "${sessionId}" is bound to Agent Driver "${existing}"; `
      + `requested "${requested}". Create a fork to switch Drivers.`,
    )
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
