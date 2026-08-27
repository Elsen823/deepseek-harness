/** Session-bound Claude Code Agent Driver and its native model mapper. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  Inbox,
  agentEvents,
  createModelSelectionOwner,
  type Agent,
  type AgentCancelCause,
  type AgentDriver,
  type AgentDriverInfo,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
  type ModelSelection,
  type ModelSelectionOwner,
  type PreparedAgentDriver,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, type LlmCallConfig, type TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  AgentDriverActivityId as makeActivityId,
  AgentDriverCheckpointId as makeCheckpointId,
  AgentDriverModelAttemptId as makeAttemptId,
  AgentDriverModelRequestId as makeRequestId,
  AgentDriverActivationId as makeActivationId,
  NativeConversationId,
} from '@deepseek-ai/dsh-session'
import type { AgentDriverId, AgentDriverActivationId, AgentDriverModelRequestId, JsonValue, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRuntimeActivation } from '@deepseek-ai/dsh-session-runtime'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  query as claudeQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultError,
  type SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk'

/** Stable durable Driver identity. */
export const CLAUDE_AGENT_DRIVER_ID = 'claude' as AgentDriverId

/** Native effort values accepted by the Claude Agent SDK. */
export type ClaudeNativeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Factory seam for the native Claude query; tests can provide a keyless stream. */
export type ClaudeQueryFactory = (params: {
  readonly prompt: string
  readonly options: Options
}) => Query

/** Explicit DSH-to-native model selection. */
export interface ClaudeNativeModelSelection {
  readonly selected: ModelSelection
  readonly nativeModel: string
  readonly nativeEffort?: ClaudeNativeEffort
}

/** Driver configuration resolved before registration. */
export interface ClaudeDriverConfig {
  /** DSH provider id represented by Claude Code. */
  readonly provider: string
  /** Default native Claude model used for a blank Session. */
  readonly model: string
  /** DSH model ids mapped to native Claude model ids. */
  readonly aliases: Readonly<Record<string, string>>
  /** Optional exact allowlist of accepted DSH or native model ids. */
  readonly supportedModels: readonly string[]
  /** Native effort values accepted by this Claude deployment. */
  readonly supportedEfforts: readonly string[]
  /** Native Claude permission mode supplied to each query. */
  readonly permissionMode: NonNullable<Options['permissionMode']>
  /** Explicit Claude Code executable path, when configured. */
  readonly cliPath?: string
  /** Optional host callback that retains Claude's native approval decision. */
  readonly canUseTool?: NonNullable<Options['canUseTool']>
  /** Optional host callback that retains Claude's native MCP user-input decision. */
  readonly onElicitation?: NonNullable<Options['onElicitation']>
  /** Optional host callback that retains Claude's native blocking-dialog decision. */
  readonly onUserDialog?: NonNullable<Options['onUserDialog']>
  /** Dialog kinds rendered by the host callback, when one is configured. */
  readonly supportedDialogKinds?: readonly string[]
}

/** Incompatibility at the DSH-to-Claude model route seam. */
export class ClaudeModelSelectionError extends Error {
  /** @param selection - rejected DSH selection. @param reason - explicit unsupported feature. */
  constructor(readonly selection: ModelSelection, readonly reason: string) {
    super(`Claude Agent Driver cannot represent ${JSON.stringify(selection)}: ${reason}`)
    this.name = 'ClaudeModelSelectionError'
  }
}

/** Pure DSH route mapper; it never starts Claude or reads process-global state. */
export class ClaudeModelRouteMapper {
  private readonly models: ReadonlySet<string> | undefined
  private readonly efforts: ReadonlySet<string>

  constructor(private readonly config: ClaudeDriverConfig) {
    this.models = config.supportedModels.length === 0 ? undefined : new Set(config.supportedModels)
    this.efforts = new Set(config.supportedEfforts)
  }

  /**
   * Resolve one DSH selection to native Claude settings.
   * @param selection - provider, model, and optional effort selected in DSH.
   * @returns the immutable selected/native pair.
   * @throws {@link ClaudeModelSelectionError} when a field has no native form.
   */
  map(selection: ModelSelection): ClaudeNativeModelSelection {
    if (selection.provider !== this.config.provider) {
      throw new ClaudeModelSelectionError(selection, `provider "${selection.provider}" is not configured as "${this.config.provider}"`)
    }
    const nativeModel = this.config.aliases[selection.model] ?? selection.model
    if (this.models !== undefined ? !this.models.has(selection.model) && !this.models.has(nativeModel) : !isClaudeModel(nativeModel)) {
      throw new ClaudeModelSelectionError(selection, `model "${selection.model}" has no supported Claude Code representation`)
    }
    const effort = selection.reasoningEffort === undefined ? undefined : String(selection.reasoningEffort)
    if (effort !== undefined && (!isClaudeEffort(effort) || !this.efforts.has(effort))) {
      throw new ClaudeModelSelectionError(selection, `reasoning effort "${effort}" is not supported by this Claude Code runtime`)
    }
    return Object.freeze({
      selected: Object.freeze({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      }),
      nativeModel,
      ...effort === undefined ? {} : { nativeEffort: effort },
    })
  }
}

function isClaudeEffort(value: string): value is ClaudeNativeEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}

/** One internal Claude turn. */
interface RunningPhase {
  readonly kind: 'running'
  turn: number
  step: number
  abort: AbortController
  wakeRequested: boolean
  query: Query | undefined
  requestId: AgentDriverModelRequestId | undefined
  route: ClaudeNativeModelSelection | undefined
  nativeSessionId: NativeConversationId | undefined
  finalText: string | undefined
  usage: TokenUsage | undefined
  closed: boolean
}

interface MaintenancePhase {
  readonly kind: 'maintenance'
  readonly abort: AbortController
  readonly lastTurn: number
  wakeRequested: boolean
}

type Phase = { readonly kind: 'idle'; readonly lastTurn: number } | MaintenancePhase | RunningPhase

/** Exact serializable native options retained before Claude SDK I/O. */
interface ClaudeNativeOptionsSnapshot {
  readonly [key: string]: JsonValue
  readonly cwd: string
  readonly permissionMode: NonNullable<Options['permissionMode']>
  readonly includePartialMessages: true
  readonly model: string
  readonly effort?: ClaudeNativeEffort
  readonly sessionId?: NativeConversationId
  readonly resume?: NativeConversationId
  readonly pathToClaudeCodeExecutable?: string
}

const CLAUDE_RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 0,
  retryableCodes: Object.freeze(['CLAUDE_NATIVE']),
  initialDelayMs: 1,
  maxDelayMs: 1,
  jitterRatio: 0,
})

function isClaudeModel(model: string): boolean {
  return /^(?:claude[-_]|(?:opus|sonnet|haiku|fable)(?:[-_]|$))/iu.test(model)
}

function textInput(messages: readonly UserMessage[]): string {
  const blocks = messages.flatMap(message => message.content)
  if (blocks.length === 0 || blocks.some(block => block.type !== 'text')) {
    throw new TypeError('Claude Agent Driver accepts direct text Chat input only')
  }
  const text = blocks.map(block => block.type === 'text' ? block.text : '').join('')
  if (text.length === 0) throw new Error('Claude Agent Driver received an empty Chat input')
  return text
}

function lastNativeConversation(session: Session): NativeConversationId | undefined {
  for (const event of [...session.events].reverse()) {
    if (event.type === 'agent-driver/checkpoint') {
      const id = event.data.provenance?.nativeConversationId
      if (id !== undefined) return NativeConversationId(id)
    }
    if (event.type === 'agent-driver/activation') {
      const id = event.data.provenance?.nativeConversationId
      if (id !== undefined) return NativeConversationId(id)
    }
  }
  return undefined
}

interface ClaudeUsage {
  readonly input_tokens?: unknown
  readonly output_tokens?: unknown
  readonly cache_read_input_tokens?: unknown
  readonly cache_creation_input_tokens?: unknown
}

function usageFromSdk(value: ClaudeUsage | undefined): TokenUsage | undefined {
  if (value === undefined) return undefined
  const inputTokens = typeof value.input_tokens === 'number' ? value.input_tokens : undefined
  const outputTokens = typeof value.output_tokens === 'number' ? value.output_tokens : undefined
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheRead = 'cache_read_input_tokens' in value && typeof value.cache_read_input_tokens === 'number'
    ? value.cache_read_input_tokens
    : undefined
  const cacheWrite = 'cache_creation_input_tokens' in value && typeof value.cache_creation_input_tokens === 'number'
    ? value.cache_creation_input_tokens
    : undefined
  return {
    inputTokens,
    outputTokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
  }
}

function errorMessage(value: SDKResultError): string {
  return `${value.subtype}${value.errors.length === 0 ? '' : `: ${value.errors.join('; ')}`}`
}

/** A Session Agent whose only model-visible input is direct Chat text. */
export class ClaudeAgent implements Agent {
  readonly inbox: Inbox
  /** Agent-local Cordis scope disposed with this Agent. */
  readonly scope: Scope
  readonly ctx: Context
  readonly modelSelection: ModelSelectionOwner
  readonly #dispatch
  #phase: Phase
  #started = false
  #disposed = false
  #activity: Promise<void> = Promise.resolve()
  #nativeConversationId: NativeConversationId | undefined
  #activationRecorded = false

  constructor(
    private readonly rootCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ClaudeDriverConfig,
    private readonly mapper: ClaudeModelRouteMapper,
    private readonly activationId: AgentDriverActivationId,
    private readonly runtime: SessionRuntimeActivation | undefined,
    private readonly queryFactory: ClaudeQueryFactory,
  ) {
    this.#nativeConversationId = lastNativeConversation(session)
    this.#dispatch = agentEvents(rootCtx, this)
    this.modelSelection = createModelSelectionOwner(session, {
      defaultSelection: () => ({
        provider: options.provider ?? config.provider,
        model: options.model ?? config.model,
      }),
      validate: (selection) => { this.mapper.map(selection) },
      resolve: selection => this.mapper.map(selection).selected,
    })
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.#dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.#dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.#dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.#phase = { kind: 'idle', lastTurn }
    this.scope = createScope(rootCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  /** Native Claude conversation identity, when the CLI has initialized one. */
  get nativeConversationId(): NativeConversationId | undefined { return this.#nativeConversationId }
  /** Binary DSH Agent activity state. */
  get status(): AgentStatus { return this.#phase.kind === 'running' ? 'running' : 'idle' }

  /**
   * Begin accepting direct Chat input after registry publication.
   * @param _source - lifecycle source supplied by the Agent registry.
   */
  start(_source: SessionStartSource): void {
    if (this.#disposed) throw new Error(`Claude Agent ${this.id} is disposed`)
    if (this.#started) return
    this.#started = true
    if (this.inbox.hasPending) this.#wake()
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.#disposed) throw new Error(`Claude Agent ${this.id} is disposed`)
    if (message.source.kind !== 'user') throw new TypeError('Claude Agent accepts direct user Chat messages only')
    // The text-prompt Query mode has one native turn and cannot receive DSH
    // next-step input through streamInput. Queue steering at the next native
    // turn boundary so it is delivered once and never remains stranded.
    const queuedTarget = target === 'next-step' ? 'next-turn' : target
    this.inbox.append(queuedTarget, message)
    if (wakeup) {
      if (this.#phase.kind === 'idle') this.#wake()
      else this.#phase.wakeRequested = true
    }
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  /** Queue steering for the next native turn; Claude text-prompt Queries do not stream DSH steps. */
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  /** DSH prompt/context injection is intentionally not sent to native Claude. */
  inject(_message: UserMessage): void {}

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    const phase = this.#phase
    if (phase.kind === 'idle') return
    if (options.keepInbox !== true) this.inbox.clear()
    if (!phase.abort.signal.aborted) phase.abort.abort(cause)
    if (phase.kind !== 'running') return
    void phase.query?.interrupt().catch(() => {})
    phase.query?.close()
  }

  async whenIdle(): Promise<void> {
    while (true) {
      const activity = this.#activity
      await activity
      if (this.#activity === activity) return
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const phase: MaintenancePhase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.#phase.lastTurn,
      wakeRequested: false,
    }
    this.#phase = phase
    const operation = Promise.resolve().then(() => task(phase.abort.signal))
    this.#activity = operation.then(
      () => { this.#finishMaintenance(phase) },
      () => { this.#finishMaintenance(phase) },
    )
    return operation
  }

  /** Stop native query ownership and unwind the private Agent scope. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.cancel({ kind: 'disposed' })
    await this.#activity
    if (this.#activationRecorded) {
      this.session.append('agent-driver/activation', {
        owner: CLAUDE_AGENT_DRIVER_ID,
        activationId: this.activationId,
        phase: 'stopped',
        ...this.#nativeConversationId === undefined ? {} : { provenance: { kind: 'resumed' as const, nativeConversationId: this.#nativeConversationId } },
        driver: { kind: 'claude/activation', payload: { native: 'claude-code' } },
      })
    }
    this.runtime?.dispose()
    await this.scope.dispose()
  }

  /** Mark activation publication and append its active lifecycle fact. */
  markActivationActive(): void {
    if (this.#activationRecorded) return
    this.#activationRecorded = true
    this.session.append('agent-driver/activation', {
      owner: CLAUDE_AGENT_DRIVER_ID,
      activationId: this.activationId,
      phase: 'active',
      ...this.#nativeConversationId === undefined ? {} : { provenance: { kind: 'resumed' as const, nativeConversationId: this.#nativeConversationId } },
      driver: { kind: 'claude/activation', payload: { native: 'claude-code' } },
    })
  }

  #wake(): void {
    if (!this.#started || this.#disposed || this.#phase.kind !== 'idle') {
      if (this.#phase.kind === 'maintenance') this.#phase.wakeRequested = true
      return
    }
    const phase: RunningPhase = {
      kind: 'running',
      turn: this.#phase.lastTurn + 1,
      step: 0,
      abort: new AbortController(),
      wakeRequested: false,
      query: undefined,
      requestId: undefined,
      route: undefined,
      nativeSessionId: undefined,
      finalText: undefined,
      usage: undefined,
      closed: false,
    }
    this.#phase = phase
    this.#dispatch.emit('agent/status', { status: 'running' })
    const job = this.rootCtx.agents.withInitiator(this, () => this.#drive(phase)).catch((error: unknown) => {
      this.#dispatch.emit('agent/error', { turn: phase.turn, step: phase.step, error })
    }).finally(() => {
      if (this.#phase === phase) {
        this.#phase = { kind: 'idle', lastTurn: phase.turn }
        this.#dispatch.emit('agent/status', { status: 'idle' })
      }
      if (!this.#disposed && (phase.wakeRequested || this.inbox.hasPending)) this.#wake()
    })
    this.#activity = job.then(() => undefined)
  }

  /** Release maintenance ownership and hand any queued wake to the driver. */
  #finishMaintenance(phase: MaintenancePhase): void {
    if (this.#phase !== phase) return
    this.#phase = { kind: 'idle', lastTurn: phase.lastTurn }
    if (!this.#disposed && (phase.wakeRequested || this.inbox.hasPending)) this.#wake()
  }

  async #drive(phase: RunningPhase): Promise<void> {
    while (!this.#disposed && this.#phase === phase) {
      phase.wakeRequested = false
      await this.#runTurn(phase)
      if (!this.#isCurrent(phase)) return
      if (!this.#shouldContinue(phase)) return
      phase.turn += 1
      phase.step = 0
      phase.closed = false
      phase.requestId = undefined
      phase.route = undefined
      phase.nativeSessionId = undefined
      phase.finalText = undefined
      phase.usage = undefined
      phase.abort = new AbortController()
    }
  }

  async #runTurn(phase: RunningPhase): Promise<void> {
    this.session.append('turn/start', { turn: phase.turn })
    const claimed = this.inbox.claim('next-turn', phase.turn)
    const messages = claimed.filter(message => message.source.kind === 'user')
    if (messages.length === 0) {
      this.#finish(phase, { kind: 'completed' })
      return
    }
    for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
    try {
      phase.abort.signal.throwIfAborted()
      phase.route = this.mapper.map(await this.modelSelection.beginTurn(phase.abort.signal))
      phase.step = 1
      this.session.append('step/start', { turn: phase.turn, step: phase.step })
      const requestId = makeRequestId(randomUUID())
      phase.requestId = requestId
      this.modelSelection.recordEffective(phase.route.selected)
      const config: LlmCallConfig = {
        provider: phase.route.selected.provider,
        model: phase.route.selected.model,
        ...phase.route.selected.reasoningEffort === undefined ? {} : { reasoningEffort: phase.route.selected.reasoningEffort },
      }
      this.session.append('agent-driver/model-request', {
        owner: CLAUDE_AGENT_DRIVER_ID,
        activationId: this.activationId,
        requestId,
        turn: phase.turn,
        step: phase.step,
        messages,
        config,
        retryPolicy: CLAUDE_RETRY_POLICY,
        driver: {
          kind: 'claude/native-request',
          payload: {
            prompt: textInput(messages),
            nativeOptions: this.#nativeOptionsSnapshot(phase),
            nativeModel: phase.route.nativeModel,
            nativeEffort: phase.route.nativeEffort ?? null,
            nativeSelection: {
              model: phase.route.nativeModel,
              ...phase.route.nativeEffort === undefined ? {} : { effort: phase.route.nativeEffort },
            },
            ...this.#nativeConversationId === undefined ? {} : { threadId: this.#nativeConversationId },
            cwd: this.session.header.cwd ?? process.cwd(),
            nativeInputsNotExposedBySdk: ['instructions', 'skills', 'tools', 'hooks'],
          },
        },
      })
      const result = await this.#queryNative(phase, textInput(messages))
      phase.finalText = result.text
      phase.usage = result.usage
      this.session.append('agent-driver/model-attempt', {
        owner: CLAUDE_AGENT_DRIVER_ID,
        activationId: this.activationId,
        requestId,
        attemptId: makeAttemptId(randomUUID()),
        attempt: 0,
        outcome: 'succeeded',
        ...result.usage === undefined ? {} : { usage: result.usage },
        driver: { kind: 'claude/native-attempt', payload: { nativeConversationId: this.#nativeConversationId ?? null } },
      })
      this.#checkpoint(phase, 'captured')
      this.#finish(phase, { kind: 'completed' })
    } catch (error: unknown) {
      const aborted = phase.abort.signal.aborted
      if (phase.requestId !== undefined) {
        this.session.append('agent-driver/model-attempt', {
          owner: CLAUDE_AGENT_DRIVER_ID,
          activationId: this.activationId,
          requestId: phase.requestId,
          attemptId: makeAttemptId(randomUUID()),
          attempt: 0,
          outcome: aborted ? 'aborted' : 'failed',
          failure: {
            code: aborted ? 'CLAUDE_ABORTED' : 'CLAUDE_NATIVE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          driver: { kind: 'claude/native-attempt', payload: { nativeConversationId: this.#nativeConversationId ?? null } },
        })
      }
      this.#finish(phase, aborted
        ? { kind: 'aborted', reason: phase.abort.signal.reason as AgentCancelCause }
        : { kind: 'error', error: { code: 'CLAUDE_TURN_FAILED', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  #nativeOptionsSnapshot(phase: RunningPhase): ClaudeNativeOptionsSnapshot {
    if (phase.route === undefined) throw new Error('Claude native options requested before route resolution')
    const cwd = this.session.header.cwd ?? process.cwd()
    const common = {
      cwd,
      permissionMode: this.config.permissionMode,
      includePartialMessages: true as const,
      model: phase.route.nativeModel,
      ...phase.route.nativeEffort === undefined ? {} : { effort: phase.route.nativeEffort },
      ...this.config.cliPath === undefined ? {} : { pathToClaudeCodeExecutable: this.config.cliPath },
    }
    if (this.#nativeConversationId === undefined) {
      const sessionId = phase.nativeSessionId ??= NativeConversationId(randomUUID())
      return { ...common, sessionId }
    }
    return { ...common, resume: this.#nativeConversationId }
  }

  async #queryNative(phase: RunningPhase, prompt: string): Promise<{ text: string; usage?: TokenUsage }> {
    const snapshot = this.#nativeOptionsSnapshot(phase)
    const canUseTool = this.config.canUseTool
    const onElicitation = this.config.onElicitation
    const onUserDialog = this.config.onUserDialog
    const options: Options = {
      ...snapshot,
      abortController: phase.abort,
      ...canUseTool === undefined ? {} : {
        canUseTool: (toolName, input, callbackOptions) => this.#withAttention(
          'approval',
          () => canUseTool(toolName, input, callbackOptions),
        ),
      },
      ...onElicitation === undefined ? {} : {
        onElicitation: (request, callbackOptions) => this.#withAttention(
          'user-input',
          () => onElicitation(request, callbackOptions),
        ),
      },
      ...onUserDialog === undefined ? {} : {
        onUserDialog: (request, callbackOptions) => this.#withAttention(
          'user-input',
          () => onUserDialog(request, callbackOptions),
        ),
      },
      ...this.config.supportedDialogKinds === undefined ? {} : {
        supportedDialogKinds: [...this.config.supportedDialogKinds],
      },
    }
    this.runtime?.setPhase(this.#nativeConversationId === undefined ? 'starting' : 'resuming')
    const query = this.queryFactory({ prompt, options })
    phase.query = query
    let text = ''
    let usage: TokenUsage | undefined
    let result: SDKResultSuccess | undefined
    try {
      for await (const event of query) {
        phase.abort.signal.throwIfAborted()
        this.#observeNativeEvent(event, phase)
        if (event.type === 'result') {
          if (event.subtype === 'success') {
            if (event.is_error) throw new Error('Claude Code returned an unsuccessful result')
            result = event
            text = event.result
            usage = usageFromSdk(event.usage)
          } else {
            throw new Error(errorMessage(event))
          }
        }
      }
    } finally {
      phase.query = undefined
    }
    if (result === undefined) throw new Error('Claude Code ended without a final result')
    return { text, ...usage === undefined ? {} : { usage } }
  }

  /** Run one native interaction callback while it contributes to runtime attention. */
  async #withAttention<T>(kind: 'approval' | 'user-input', operation: () => Promise<T>): Promise<T> {
    const runtime = this.ctx.get('sessionRuntimes')
    const release = runtime?.attend(this.session.header, kind)
    try {
      return await operation()
    } finally {
      await release?.()
    }
  }

  #observeNativeEvent(event: SDKMessage, phase: RunningPhase): void {
    if (event.type === 'system' && event.subtype === 'init') {
      this.#nativeConversationId = NativeConversationId(event.session_id)
      this.runtime?.setPhase('active')
      return
    }
    if (event.type === 'assistant') {
      const assistant = event
      const usage = usageFromSdk(assistant.message.usage)
      if (usage !== undefined) phase.usage = usage
      for (const block of assistant.message.content) {
        if (block.type === 'tool_use') this.#activityEvent(phase, 'tool', 'started', block.name)
        else if (block.type === 'thinking') this.#activityEvent(phase, 'reasoning', 'observed', 'Claude reasoning summary')
      }
      return
    }
    if (event.type === 'result') return
    if (event.type === 'stream_event') return
    const subtype = event.type === 'system' ? event.subtype : event.type
    this.#activityEvent(phase, `native/${subtype}`, 'observed', subtype)
  }

  #activityEvent(phase: RunningPhase, kind: string, activityPhase: string, title: string): void {
    const payload = { kind, phase: activityPhase, title }
    const serialized = JSON.stringify(payload)
    this.session.append('agent-driver/activity', {
      owner: CLAUDE_AGENT_DRIVER_ID,
      activationId: this.activationId,
      activityId: makeActivityId(`claude:${phase.turn}:${phase.step}:${randomUUID()}`),
      kind,
      phase: activityPhase,
      groupId: makeActivityId(`claude:turn:${phase.turn}`),
      title,
      data: { storage: 'inline', bytes: Buffer.byteLength(serialized), data: payload },
      driver: { kind: 'claude/native-event', payload: { title } },
    })
  }

  #checkpoint(phase: RunningPhase, checkpointPhase: 'captured' | 'failed' | 'restored'): void {
    this.session.append('agent-driver/checkpoint', {
      owner: CLAUDE_AGENT_DRIVER_ID,
      activationId: this.activationId,
      checkpointId: makeCheckpointId(`claude:${this.id}:turn:${phase.turn}`),
      phase: checkpointPhase,
      ...this.#nativeConversationId === undefined ? {} : { provenance: { kind: checkpointPhase === 'restored' ? 'resumed' as const : 'created' as const, nativeConversationId: this.#nativeConversationId } },
      compatibility: { runtime: 'claude-agent-sdk@0.3.220', status: checkpointPhase === 'restored' ? 'same' as const : 'unknown' as const },
      driver: {
        kind: 'claude/session-checkpoint',
        payload: { nativeConversationId: this.#nativeConversationId ?? null, turn: phase.turn },
      },
    })
  }

  #finish(phase: RunningPhase, reason: TurnEndReason): void {
    if (phase.closed) return
    phase.closed = true
    if (phase.step > 0) this.session.append('step/end', { turn: phase.turn, step: phase.step })
    if (phase.finalText !== undefined && phase.route !== undefined) {
      this.session.append('assistant/message', {
        turn: phase.turn,
        step: phase.step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: phase.finalText }],
          source: { provider: phase.route.selected.provider, model: phase.route.selected.model },
        }),
        ...phase.usage === undefined ? {} : { usage: phase.usage },
      }, { surfaceOp: 'append' })
    }
    this.session.append('turn/end', { turn: phase.turn, reason })
  }

  /** Whether this phase still owns the live Claude activity after an await. */
  #isCurrent(phase: RunningPhase): boolean {
    return !this.#disposed && this.#phase === phase
  }

  /** Read the post-turn wake and inbox state across the awaited native query. */
  #shouldContinue(phase: RunningPhase): boolean {
    return phase.wakeRequested || this.inbox.hasPending
  }
}

/** Agent Driver that keeps Claude-specific protocol and native execution out of core. */
export class ClaudeAgentDriver implements AgentDriver {
  readonly info: AgentDriverInfo = Object.freeze({ id: CLAUDE_AGENT_DRIVER_ID, name: 'Claude Code' })
  readonly #mapper: ClaudeModelRouteMapper

  constructor(
    private readonly ctx: Context,
    readonly config: ClaudeDriverConfig,
    private readonly queryFactory: ClaudeQueryFactory = params => claudeQuery(params),
  ) {
    this.#mapper = new ClaudeModelRouteMapper(config)
  }

  validateModelSelection(selection: ModelSelection): void { this.#mapper.map(selection) }

  prepare(session: Session, options: AgentOptions, signal: AbortSignal): PreparedAgentDriver {
    signal.throwIfAborted()
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
      throw new TypeError('Claude Agent maxTokens must be a positive safe integer')
    }
    const activationId = makeActivationId(randomUUID())
    const runtime = this.ctx.get('sessionRuntimes')?.begin(session.header, {
      phase: 'starting',
      detail: { kind: 'claude/activation', data: { native: 'claude-code' } },
    })
    const agent = new ClaudeAgent(
      this.ctx,
      session.id,
      options,
      session,
      this.config,
      this.#mapper,
      activationId,
      runtime,
      this.queryFactory,
    )
    const prepared: PreparedAgentDriver = {
      agent,
      start: (source) => {
        agent.markActivationActive()
        agent.start(source)
      },
      dispose: async () => {
        await agent.dispose()
      },
    }
    return prepared
  }
}

/** Read-only summary derived from a Claude-backed Session's durable events. */
export type ClaudeSessionObservation = {
  readonly sessionId: SessionId
  readonly driverId: AgentDriverId
  readonly nativeConversationId?: NativeConversationId
  readonly activities: number
  readonly status: 'cold' | 'active'
}
