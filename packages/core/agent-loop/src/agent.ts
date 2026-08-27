/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  ModelSelection,
  ModelSelectionOwner,
  PreStepDecision,
  RequestErrorAction,
  TurnModelSelection,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor, createModelSelectionOwner } from '@deepseek-ai/dsh-agent'
import type {
  GenerateOptions,
  LlmCallConfig,
  Message,
  PreparedLlmCall,
} from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  callConfigEquals,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | {
    kind: 'running'
    abort: AbortController
    turn: number
    step: number
    wakeRequested: boolean
    /** Final turn-end check is in progress; wakeups must survive the idle handoff. */
    closing: boolean
  }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/** Project one resolved call config onto the fields owned by Model Selection. */
function selectionFromConfig(config: LlmCallConfig): ModelSelection {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

/** Build the provider lookup config without admitting unrelated request settings. */
function selectionCallConfig(selection: ModelSelection): LlmCallConfig {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Apply the immutable Turn selection after request middleware runs. */
function applyTurnSelection(config: LlmCallConfig, selection: TurnModelSelection): LlmCallConfig {
  const { reasoningEffort: _ignoredEffort, ...withoutEffort } = config
  return {
    ...withoutEffort,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  readonly modelSelection: ModelSelectionOwner
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  /** Immutable selection captured for every step in the current Turn. */
  private turnSelection: TurnModelSelection | undefined
  /** One exact-model preparation retained from Turn start through the first request. */
  private pendingPreparedCall: PreparedLlmCall | undefined
  /** Whether Turn-start resolution materialized an omitted reasoning effort. */
  private turnReasoningEffortDefaulted = false

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.modelSelection = createModelSelectionOwner(session, {
      defaultSelection: () => options.provider === undefined || options.model === undefined
        ? undefined
        : { provider: options.provider, model: options.model },
      validate: async (selection) => {
        await this.loopCtx.llm.resolveCallConfig(selectionCallConfig(selection))
      },
      resolve: async (selection, signal) => {
        const selected = this.modelSelection.selected
        const resolvedSelection = selected?.source === 'default'
          && options.provider !== undefined
          && options.model !== undefined
          ? {
            provider: options.provider,
            model: options.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          }
          : selection
        const prepared = await this.loopCtx.llm.prepareCall(selectionCallConfig(resolvedSelection), signal)
        this.pendingPreparedCall = prepared
        return selectionFromConfig(prepared.config)
      },
    })
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(true, wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeup - whether a caller requested an activity wake.
   * @param wakeAfterAbort - whether the wake was redirected past an aborted activity.
   */
  private wakeDriver(wakeup = false, wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // A live driver usually claims queued work itself. Retain a wake only
      // during the final turn-end check or after cancellation, so a message
      // admitted across the idle handoff cannot be stranded. Disposal never
      // latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && wakeup
        && (this.phase.kind === 'maintenance' || this.phase.closing || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
      closing: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    if (position.step === 1 && claimed.length > 0) {
      const requested = this.modelSelection.selected === undefined
        ? this.modelSelection.defaultSelection
        : this.modelSelection.selected
      const hadExplicitEffort = requested?.reasoningEffort !== undefined
      this.turnSelection = await this.modelSelection.beginTurn(signal)
      this.turnReasoningEffortDefaulted = !hadExplicitEffort && this.turnSelection.reasoningEffort !== undefined
    }
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal, this.turnSelection))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    this.turnSelection = undefined
    this.turnReasoningEffortDefaulted = false
    this.pendingPreparedCall = undefined
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      this.pendingPreparedCall = undefined
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    // Mark the narrow handoff window before checking the inbox. A wake can
    // arrive from a microtask scheduled by the turn-end append after this
    // check but before kick() publishes idle; wakeDriver retains that request.
    phase.closing = true
    if (!this.inbox.hasPending) return false
    phase.closing = false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    if (this.turnSelection === undefined) {
      throw new Error(`agent "${this.id}" has no immutable Turn Model Selection`)
    }
    // Every request in a Turn starts from the captured route. Request headers
    // still carry unrelated envelope fields and adapter-default markers.
    const persistedHeader = session.requestHeader()
    const route = { provider: this.turnSelection.provider, model: this.turnSelection.model }
    const reasoningEffort = this.turnSelection.reasoningEffort
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const waterfallConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    const proposedConfig = applyTurnSelection(waterfallConfig, this.turnSelection)
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model in its immutable Turn Model Selection`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    const pending = this.pendingPreparedCall
    const pendingProposal = pending === undefined ? undefined : { ...pending.config }
    if (pendingProposal !== undefined) {
      const pendingDefaults = pending?.adapterDefaults
      if (pendingDefaults?.reasoningEffort === true) delete pendingProposal.reasoningEffort
      if (pendingDefaults?.maxTokens === true) delete pendingProposal.maxTokens
    }
    if (pending !== undefined && (callConfigEquals(proposedConfig, pending.config)
      || pendingProposal !== undefined && callConfigEquals(proposedConfig, pendingProposal))) {
      preparedCall = pending
      this.pendingPreparedCall = undefined
      config = preparedCall.config
    } else {
      this.pendingPreparedCall = undefined
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    }
    const adapterDefaults = preparedCall.adapterDefaults
    const effectiveAdapterDefaults = this.turnReasoningEffortDefaulted
      && config.reasoningEffort !== undefined
      && adapterDefaults.reasoningEffort !== true
      ? { ...adapterDefaults, reasoningEffort: true as const }
      : adapterDefaults
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      adapterDefaults: effectiveAdapterDefaults,
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, preparedCall }
  }

}
