import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GoalId } from '@deepseek-ai/dsh-goal'
import * as Objective from '@deepseek-ai/dsh-objective'
import { applyObjectiveProjection } from '@deepseek-ai/dsh-objective'
import SessionStore, {
  AgentDriverId,
  SessionId,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

async function setup(withObjective = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = withObjective ? await ctx.plugin(Objective) : undefined
  const session = ctx.sessions.create(SessionId('objective-projection'), {
    meta: { driverId: AgentDriverId('codex') },
  })
  return { ctx, fiber, session }
}

describe('portable Objective projection', () => {
  it('adapts authoritative DSH Goal snapshots without a duplicate event', async () => {
    const { ctx, session } = await setup()
    session.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'block',
      goal: {
        id: GoalId('goal-1'),
        revision: 4,
        objective: 'ship the portable projection',
        phase: 'blocked',
        blockedReason: { code: 'waiting-user', message: 'Need a decision.' },
        maxGoalRounds: 12,
      },
      roundsStarted: 5,
      createdAt: 10,
      updatedAt: 20,
    })

    expect(session.events.map(event => event.type)).toEqual(['goal/change'])
    expect(ctx.sessionProjections.snapshot(session).values.objective).toEqual({
      owner: 'dsh',
      objective: 'ship the portable projection',
      phase: 'blocked',
      budget: { kind: 'goal-rounds', unit: 'rounds', limit: 12, consumed: 5 },
      attention: { kind: 'blocked', message: 'Need a decision.' },
      routing: { goalId: 'goal-1', revision: 4 },
    })
  })

  it('folds native whole Objective snapshots and clear snapshots last-wins', async () => {
    const { ctx, session } = await setup()
    session.append('agent-driver/objective', {
      objective: {
        owner: AgentDriverId('codex'),
        objective: 'port a Codex objective',
        phase: 'active',
        budget: { kind: 'model-tokens', unit: 'tokens', limit: 100_000, consumed: 1200 },
        routing: { threadId: 'thread-1' },
      },
      driver: { kind: 'codex/objective', payload: { nativePhase: 'inProgress' } },
    })
    expect(ctx.sessionProjections.snapshot(session).values.objective).toEqual({
      owner: 'codex',
      objective: 'port a Codex objective',
      phase: 'active',
      budget: { kind: 'model-tokens', unit: 'tokens', limit: 100_000, consumed: 1200 },
      routing: { threadId: 'thread-1' },
    })

    session.append('agent-driver/objective', {
      objective: null,
      driver: { kind: 'codex/objective', payload: { reason: 'cleared' } },
    })
    expect(ctx.sessionProjections.snapshot(session).values.objective).toBeNull()
  })

  it('keeps native facts readable when the projection provider unloads', async () => {
    const { ctx, fiber, session } = await setup()
    const event = session.append('agent-driver/objective', {
      objective: {
        owner: AgentDriverId('future-driver'),
        objective: 'retain unknown owner state',
        phase: 'pending',
      },
      driver: { kind: 'future/objective-v3', payload: { opaque: true } },
    })
    expect(ctx.sessionProjections.snapshot(session).values.objective).not.toBeNull()

    await fiber?.dispose()

    expect('objective' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    expect(event.data.driver).toEqual({ kind: 'future/objective-v3', payload: { opaque: true } })
    expect(event.data.objective?.owner).toBe('future-driver')
  })

  it('returns the same reference for unrelated events', () => {
    const state = {
      owner: AgentDriverId('codex'),
      objective: 'unchanged',
      phase: 'active' as const,
    }
    const event = { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } as never
    expect(applyObjectiveProjection(state, event)).toBe(state)
  })
})
