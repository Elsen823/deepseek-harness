/** Portable Driver-neutral Objective projection. @module @deepseek-ai/dsh-objective */

import type { Context } from '@deepseek-ai/cordis'
import { decodeGoalChange } from '@deepseek-ai/dsh-goal'
import type { GoalPhase } from '@deepseek-ai/dsh-goal/types'
import { AgentDriverId } from '@deepseek-ai/dsh-session'
import type { AgentDriverObjectivePhase, AgentDriverObjectiveSnapshot, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ObjectiveProjection } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'objective'
/** The projection registry is the provider's only runtime service dependency. */
export const inject = ['sessionProjections']

const objectiveSchema: ZodType<ObjectiveProjection> = z.object({
  owner: z.string(),
  objective: z.string(),
  phase: z.enum(['pending', 'active', 'paused', 'blocked', 'completed', 'failed', 'cancelled']),
  budget: z.object({
    kind: z.string(),
    unit: z.string(),
    limit: z.number().optional(),
    consumed: z.number().optional(),
  }).strict().optional(),
  attention: z.object({
    kind: z.string(),
    message: z.string().optional(),
  }).strict().optional(),
  stopReason: z.object({
    kind: z.string(),
    message: z.string().optional(),
  }).strict().optional(),
  routing: z.json().optional(),
}).strict().nullable() as ZodType<ObjectiveProjection>

/** Normalize one authoritative DSH Goal phase without importing its identity or CAS semantics. */
function objectivePhase(phase: GoalPhase): AgentDriverObjectivePhase {
  return phase === 'complete' ? 'completed' : phase
}

/** Adapt one valid DSH Goal whole snapshot to the Driver-neutral Objective view. */
function adaptDshGoal(event: SessionEvent): ObjectiveProjection | undefined {
  if (event.type !== 'goal/change') return undefined
  let change: ReturnType<typeof decodeGoalChange>
  try {
    change = decodeGoalChange(event.data)
  } catch (_invalidPersistedGoalChange) {
    return undefined
  }
  if (change === undefined) return undefined
  if (change.operation === 'clear') return null
  const goal = change.goal
  const blockedMessage = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined
  return {
    owner: AgentDriverId('dsh'),
    objective: goal.objective,
    phase: objectivePhase(goal.phase),
    budget: {
      kind: 'goal-rounds',
      unit: 'rounds',
      limit: goal.maxGoalRounds,
      consumed: change.roundsStarted,
    },
    ...(blockedMessage === undefined ? {} : { attention: { kind: 'blocked', message: blockedMessage } }),
    ...(goal.phase === 'complete' ? { stopReason: { kind: 'completed' } } : {}),
    routing: { goalId: goal.id, revision: goal.revision },
  }
}

/**
 * Fold one native Objective snapshot or authoritative DSH Goal change.
 * Native snapshots win at their event position; no adapter emits a duplicate
 * `agent-driver/objective` event for a DSH Goal mutation.
 * @param state - Objective covering all prior events.
 * @param event - next committed Session event.
 * @returns the next whole Objective, or the same reference for unrelated or malformed events.
 */
export function applyObjectiveProjection(state: ObjectiveProjection, event: SessionEvent): ObjectiveProjection {
  if (event.type === 'agent-driver/objective') return event.data.objective
  const adapted = adaptDshGoal(event)
  return adapted === undefined ? state : adapted
}

const activeProducers = new WeakSet<SessionProjectionRegistry>()

/**
 * Register the sole portable Objective projection producer for this registry.
 * @param ctx - registrant context carrying the projection registry.
 * @throws if another package instance already owns the `objective` projection.
 */
export function apply(ctx: Context): void {
  const registry = ctx.sessionProjections
  ctx.effect(function* () {
    if (activeProducers.has(registry)) throw new Error('objective projection producer is already registered')
    activeProducers.add(registry)
    try {
      registry.register<'objective', ObjectiveProjection>({
        key: 'objective',
        stateSchema: objectiveSchema,
        init: () => null,
        apply: applyObjectiveProjection,
        wire: { viewSchema: objectiveSchema, view: state => state },
        stateVersion: 1,
      })
    } catch (error) {
      activeProducers.delete(registry)
      throw error
    }
    yield () => activeProducers.delete(registry)
  }, 'objective projection producer')
}

export type { AgentDriverObjectiveSnapshot }
