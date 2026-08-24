/** Portable Proposed Plan projection types and projection-key declaration. @module @deepseek-ai/dsh-plan-proposal/types */

import type { AgentDriverProposedPlanSnapshot } from '@deepseek-ai/dsh-session/types'

export type {
  AgentDriverProposedPlanId as ProposedPlanId,
  AgentDriverProposedPlanLifecycle as ProposedPlanLifecycle,
  AgentDriverProposedPlanRelation as ProposedPlanRelation,
  AgentDriverProposedPlanSnapshot as ProposedPlanSnapshot,
} from '@deepseek-ai/dsh-session/types'

/** Current whole Proposed Plan document, or `null` before the first proposal. */
export type ProposedPlanProjection = AgentDriverProposedPlanSnapshot | null

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    proposedPlan: ProposedPlanProjection
  }
  interface SessionProjectionMap {
    /** Current durable Proposed Plan document, independent of Plan Mode and Checklist state. */
    proposedPlan: ProposedPlanProjection
  }
}
