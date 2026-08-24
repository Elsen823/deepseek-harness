import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as PlanProposal from '@deepseek-ai/dsh-plan-proposal'
import { applyProposedPlanProjection, ProposedPlanId } from '@deepseek-ai/dsh-plan-proposal'
import SessionStore, { AgentDriverId, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(PlanProposal)
  const session = ctx.sessions.create(SessionId('proposed-plan-projection'), {
    meta: { driverId: AgentDriverId('codex') },
  })
  return { ctx, fiber, session }
}

describe('portable Proposed Plan projection', () => {
  it('folds the complete document lifecycle last-wins', async () => {
    const { ctx, session } = await setup()
    const base = {
      id: ProposedPlanId('plan-1'),
      owner: AgentDriverId('codex'),
      title: 'Implement durable projections',
      content: '# Implement durable projections\n\nUse pure folds.',
    }

    for (const lifecycle of ['proposed', 'accepted', 'rejected', 'superseded'] as const) {
      session.append('agent-driver/proposed-plan', {
        plan: {
          ...base,
          lifecycle,
          ...(lifecycle === 'superseded'
            ? { relation: { kind: 'superseded-by', planId: ProposedPlanId('plan-2') } }
            : {}),
          routing: { threadId: 'thread-1' },
        },
        driver: { kind: 'codex/plan', payload: { nativeStatus: lifecycle } },
      })
      expect(ctx.sessionProjections.snapshot(session).values.proposedPlan).toMatchObject({
        id: 'plan-1',
        owner: 'codex',
        lifecycle,
      })
    }

    session.append('agent-driver/proposed-plan', {
      plan: null,
      driver: { kind: 'codex/plan-cleared' },
    })
    expect(ctx.sessionProjections.snapshot(session).values.proposedPlan).toBeNull()
  })

  it('keeps an unknown Driver document readable after provider unload', async () => {
    const { ctx, fiber, session } = await setup()
    const event = session.append('agent-driver/proposed-plan', {
      plan: {
        id: ProposedPlanId('future-plan'),
        owner: AgentDriverId('future-driver'),
        title: 'Future plan',
        content: '# Future plan',
        lifecycle: 'proposed',
        routing: { opaqueRoute: 7 },
      },
      driver: { kind: 'future/plan-v7', payload: { opaque: true } },
    })

    await fiber.dispose()

    expect('proposedPlan' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    expect(event.data.plan).toMatchObject({ id: 'future-plan', owner: 'future-driver', title: 'Future plan' })
    expect(event.data.driver).toEqual({ kind: 'future/plan-v7', payload: { opaque: true } })
  })

  it('returns the same reference for unrelated events', () => {
    const state = {
      id: ProposedPlanId('plan-1'),
      owner: AgentDriverId('codex'),
      title: 'Plan',
      content: '# Plan',
      lifecycle: 'proposed' as const,
    }
    const event = { type: 'plan/mode', seq: 1, time: 2, data: { active: true } } as never
    expect(applyProposedPlanProjection(state, event)).toBe(state)
  })
})
