/** Portable Objective projection types and projection-key declaration. @module @deepseek-ai/dsh-objective/types */

import type { AgentDriverObjectiveSnapshot } from '@deepseek-ai/dsh-session/types'

/** Driver-neutral whole Objective snapshot. */
export type ObjectiveSnapshot = AgentDriverObjectiveSnapshot

/** Current portable Objective, or `null` when no owner reports one. */
export type ObjectiveProjection = ObjectiveSnapshot | null

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    objective: ObjectiveProjection
  }
  interface SessionProjectionMap {
    /** Driver-neutral Objective adapted from native snapshots or authoritative DSH Goal changes. */
    objective: ObjectiveProjection
  }
}
