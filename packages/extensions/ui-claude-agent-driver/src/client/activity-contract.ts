import type { AgentDriverActivitySnapshot } from '@deepseek-ai/dsh-session'
import type { ConversationLocation, ConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'

/** One generic Agent Driver activity fact projected for a read-only view. */
export interface DriverActivityViewNode extends ConversationViewNode {
  readonly target: 'driver-activity'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: AgentDriverActivitySnapshot
}

/** Bounded read-only Activity projection for one DSH Session. */
export interface DriverActivitySnapshot {
  readonly activities: readonly DriverActivityViewNode[]
}

/** Explicit empty target used while a Session is still cold or has no facts. */
export const EMPTY_DRIVER_ACTIVITY: DriverActivitySnapshot = { activities: [] }

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Generic native Agent Driver activity, rendered by an optional surface. */
    'driver-activity': DriverActivitySnapshot
  }
}
