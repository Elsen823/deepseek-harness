/** Portable Proposed Plan document projection. @module @deepseek-ai/dsh-plan-proposal */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ProposedPlanProjection } from './types.ts'

export type * from './types.ts'
export { AgentDriverProposedPlanId as ProposedPlanId } from '@deepseek-ai/dsh-session'

/** Cordis plugin name. */
export const name = 'plan-proposal'
/** The projection registry is the provider's only runtime dependency. */
export const inject = ['sessionProjections']

const proposedPlanSchema: ZodType<ProposedPlanProjection> = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  content: z.string(),
  lifecycle: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  relation: z.object({
    kind: z.string(),
    planId: z.string().optional(),
    data: z.json().optional(),
  }).strict().optional(),
  routing: z.json().optional(),
}).strict().nullable() as ZodType<ProposedPlanProjection>

/**
 * Fold the latest whole Proposed Plan document snapshot.
 * @param state - Proposed Plan covering all prior events.
 * @param event - next committed Session event.
 * @returns the latest whole document, or the same reference for unrelated events.
 */
export function applyProposedPlanProjection(
  state: ProposedPlanProjection,
  event: SessionEvent,
): ProposedPlanProjection {
  return event.type === 'agent-driver/proposed-plan' ? event.data.plan : state
}

const activeProducers = new WeakSet<SessionProjectionRegistry>()

/**
 * Register the sole portable Proposed Plan projection producer for this registry.
 * @param ctx - registrant context carrying the projection registry.
 * @throws if another package instance already owns the `proposedPlan` projection.
 */
export function apply(ctx: Context): void {
  const registry = ctx.sessionProjections
  ctx.effect(function* () {
    if (activeProducers.has(registry)) throw new Error('proposed-plan projection producer is already registered')
    activeProducers.add(registry)
    try {
      registry.register<'proposedPlan', ProposedPlanProjection>({
        key: 'proposedPlan',
        stateSchema: proposedPlanSchema,
        init: () => null,
        apply: applyProposedPlanProjection,
        wire: { viewSchema: proposedPlanSchema, view: state => state },
        stateVersion: 1,
      })
    } catch (error) {
      activeProducers.delete(registry)
      throw error
    }
    yield () => activeProducers.delete(registry)
  }, 'proposed-plan projection producer')
}
