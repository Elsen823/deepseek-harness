import { describe, expect, it } from 'vitest'
import {
  createModelSelectionOwner,
  type ModelSelection,
} from '../src/index.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { AgentDriverId, Session, SessionId } from '@deepseek-ai/dsh-session'

describe('Agent-owned ModelSelectionOwner', () => {
  it('persists accepted intent, folds it on resume, and does not mix service tier into the selection', async () => {
    const session = Session.create(SessionId('selection-owner'))
    const owner = createModelSelectionOwner(session)
    const selected: ModelSelection = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
    }

    await expect(owner.accept(selected)).resolves.toMatchObject({ ...selected, source: 'user' })
    expect(session.events).toHaveLength(1)
    expect(session.events[0]).toMatchObject({ type: 'model/selected', data: { ...selected, source: 'user' } })
    expect(session.events[0]?.data).not.toHaveProperty('serviceTier')
    await expect(owner.accept(selected)).resolves.toMatchObject({ ...selected, source: 'user' })
    expect(session.events).toHaveLength(1)
    expect(owner.selected).toMatchObject({ ...selected, source: 'user' })

    const restored = Session.fromRestore(
      SessionId('selection-owner'),
      structuredClone(session.events),
      {
        version: 0,
        driverId: AgentDriverId('dsh'),
        id: SessionId('selection-owner'),
        createdAt: 1,
      },
    )
    expect(createModelSelectionOwner(restored).selected).toMatchObject({ ...selected, source: 'user' })
  })
  it('materializes a default only at Turn start and freezes one resolved Turn selection', async () => {
    const session = Session.create(SessionId('selection-default'))
    const owner = createModelSelectionOwner(session, {
      defaultSelection: () => ({ provider: 'route', model: 'model' }),
      resolve: async selection => ({ ...selection, reasoningEffort: ReasoningEffortId('standard') }),
    })

    expect(owner.selected).toBeUndefined()
    expect(owner.defaultSelection).toEqual({ provider: 'route', model: 'model' })
    const turn = await owner.beginTurn()

    expect(turn).toEqual({ provider: 'route', model: 'model', reasoningEffort: ReasoningEffortId('standard') })
    expect(Object.isFrozen(turn)).toBe(true)
    expect(owner.selected).toEqual({ provider: 'route', model: 'model', source: 'default' })
    expect(session.events.map(event => event.type)).toEqual(['model/selected'])
  })

})
