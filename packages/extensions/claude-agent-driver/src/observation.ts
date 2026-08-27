/** Read-only durable observation helpers for Claude-backed Sessions. */

import { NativeConversationId, type Session } from '@deepseek-ai/dsh-session'
import { CLAUDE_AGENT_DRIVER_ID, type ClaudeSessionObservation } from './driver.ts'

/**
 * Read native identity and declared activity without activating Claude or
 * issuing a native query. This is the browser/TUI observation contract.
 * @param session - the durable Session to inspect.
 * @returns an immutable observation derived only from its log.
 */
export function observeClaudeSession(session: Session): ClaudeSessionObservation {
  let nativeConversationId: ClaudeSessionObservation['nativeConversationId']
  let activities = 0
  for (const event of session.events) {
    if (event.type === 'agent-driver/activity' && event.data.owner === CLAUDE_AGENT_DRIVER_ID) activities += 1
    if (event.type === 'agent-driver/checkpoint' && event.data.owner === CLAUDE_AGENT_DRIVER_ID) {
      const candidate = event.data.provenance?.nativeConversationId
      if (candidate !== undefined) nativeConversationId = NativeConversationId(candidate)
    }
    if (event.type === 'agent-driver/activation' && event.data.owner === CLAUDE_AGENT_DRIVER_ID) {
      const candidate = event.data.provenance?.nativeConversationId
      if (candidate !== undefined) nativeConversationId = NativeConversationId(candidate)
    }
  }
  return Object.freeze({
    sessionId: session.id,
    driverId: CLAUDE_AGENT_DRIVER_ID,
    ...nativeConversationId === undefined ? {} : { nativeConversationId },
    activities,
    status: nativeConversationId === undefined ? 'cold' as const : 'active' as const,
  })
}

export type { ClaudeSessionObservation }
