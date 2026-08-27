/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 * Mirrors the Python SDK's `DeepSeekHarness`/`Session` pair.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AgentDriverCatalogResult, SelectedModelSelection, SessionRuntimeResult } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessClientOptions, HarnessNotification, RunResult } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly launch: HarnessClientOptions
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private readonly driverId: string | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options: DeepSeekHarnessOptions) {
    this.launch = options.launch
    this.clientInstance = new HarnessClient(options.launch)
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.launch.cwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = options.maxTokens
    this.driverId = options.driverId
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake reaps its runtime and swaps in a fresh instance, so do not
   * cache this across a failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure the runtime is reaped and a fresh client replaces it
   * (`HarnessClient.close` is permanent), so a later call retries with a new
   * subprocess — unless {@link close} already ended this harness.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
          ...this.driverId === undefined ? {} : { driverId: this.driverId },
        })
      } catch (error) {
        this.initialized = undefined
        await this.clientInstance.close()
        if (!this.closed) this.clientInstance = new HarnessClient(this.launch)
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @param driverId - immutable Driver for lazy creation; defaults to the harness selection.
   * @returns the session handle.
   */
  session(sessionId?: string, driverId = this.driverId): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`, driverId)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | ContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId, options?.driverId ?? this.driverId).run(input, options)
  }

  /**
   * Read the active Driver catalog from the initialized runtime.
   * @returns the Host-resolved default and active Driver registrations.
   */
  async drivers(): Promise<AgentDriverCatalogResult> {
    await this.start()
    return await this.clientInstance.drivers()
  }

  /**
   * Read one process-local Session runtime value without activating it.
   * @param sessionId - durable Session identity.
   * @returns the current runtime value, or `null` when this process has none.
   */
  async runtime(sessionId: string): Promise<SessionRuntimeResult> {
    await this.start()
    return await this.clientInstance.runtime(sessionId)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Immutable Driver for a newly created Session; must match an existing binding. */
  driverId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   * @param driverId - immutable Driver for lazy creation.
   */
  constructor(
    readonly harness: DeepSeekHarness,
    readonly id: string,
    readonly driverId?: string,
  ) {}

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | ContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks, this.driverId)
      let received = false
      while (true) {
        const notification = await subscription.next()
        const unavailable = unavailableRuntime(notification)
        if (unavailable?.sessionId === this.id) {
          collect(notification)
          throw new SdkProtocolError(
            `session "${this.id}" is unavailable (${unavailable.code}): ${unavailable.message}`,
          )
        }
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

interface UnavailableRuntime {
  readonly sessionId: string
  readonly code: string
  readonly message: string
}

/**
 * Validate and extract one unavailable Session runtime notification.
 * @param notification - raw SDK notification.
 * @returns the diagnosis, or `undefined` for every other notification.
 */
function unavailableRuntime(notification: HarnessNotification): UnavailableRuntime | undefined {
  if (notification.method !== 'session.runtime') return undefined
  const status = notification.params.status
  if (!isRecord(status) || typeof status.sessionId !== 'string' || !isRecord(status.availability)) {
    throw new SdkProtocolError(`session.runtime carried malformed status: ${JSON.stringify(status)}`)
  }
  if (status.availability.kind !== 'unavailable') return undefined
  const reason = status.availability.reason
  if (!isRecord(reason)
    || typeof reason.code !== 'string'
    || typeof reason.message !== 'string'
    || typeof reason.retryable !== 'boolean') {
    throw new SdkProtocolError(`session.runtime carried malformed unavailable reason: ${JSON.stringify(reason)}`)
  }
  return { sessionId: status.sessionId, code: reason.code, message: reason.message }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/**
 * Fold the latest accepted Model Selection from one SDK event interval.
 * Effective request evidence remains available as its own `request/header` or
 * `agent-driver/model-request` event and is not confused with this intent.
 * @param events - durable Session events projected by the runtime.
 * @returns the latest accepted selection, or `undefined` before one is seen.
 */
export function selectedModelSelection(events: SessionEvent[]): SelectedModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'model/selected') continue
    return event.data
  }
  return undefined
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'model/selected') {
    const data = isRecord(value.data)
      ? value.data
      : undefined
    if (data === undefined
      || typeof data.provider !== 'string' || data.provider.length === 0
      || typeof data.model !== 'string' || data.model.length === 0
      || (data.reasoningEffort !== undefined
        && (typeof data.reasoningEffort !== 'string' || data.reasoningEffort.length === 0))
      || (data.source !== 'user' && data.source !== 'default')
      || Object.keys(data).some(key => !['provider', 'model', 'reasoningEffort', 'source'].includes(key))) {
      throw new SdkProtocolError(`model/selected event carried malformed selection: ${JSON.stringify(value)}`)
    }
  }
  return value as unknown as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
