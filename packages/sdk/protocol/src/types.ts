/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the three
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionRuntimeStatus } from '@deepseek-ai/dsh-session-runtime/types'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** One active Agent Driver advertised by the SDK runtime. */
export interface AgentDriverCatalogItem {
  id: string
  name: string
}

/** Current Driver catalog and fresh-Session default. */
export interface AgentDriverCatalogResult {
  defaultId: string
  items: AgentDriverCatalogItem[]
}

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
  /** Default immutable Agent Driver binding for SDK-created Sessions. */
  driverId?: string
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
  /** Active Driver catalog after initialization. */
  drivers: AgentDriverCatalogResult
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
  /** Driver for lazy creation; a different value on an existing Session fails. */
  driverId?: string
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** `session.created` payload with the immutable Driver binding. */
export interface SessionCreatedNotification {
  sessionId: string
  driverId: string
  parentSessionId?: string
}

/** `session.runtime` payload with one process-local whole current value. */
export interface SessionRuntimeNotification {
  status: SessionRuntimeStatus
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Current runtime lookup for one Session id. */
export interface SessionRuntimeParams {
  sessionId: string
}

/** Runtime lookup result; `null` means this Host has not observed the Session. */
export interface SessionRuntimeResult {
  status: SessionRuntimeStatus | null
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.created': SessionCreatedNotification
  'session.runtime': SessionRuntimeNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'agent/drivers': { params: undefined; result: AgentDriverCatalogResult }
  'session/runtime': { params: SessionRuntimeParams; result: SessionRuntimeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
