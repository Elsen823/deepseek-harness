import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { AgentDriverId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Todo from '@deepseek-ai/dsh-todo'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function harness(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Todo)
  return ctx
}

describe('portable Checklist projection provider', () => {
  it('folds todo/write without ctx.tools or todo_write', async () => {
    const test = await harness()
    expect(test.get('tools')).toBeUndefined()
    const session = test.sessions.create(undefined, { meta: { driverId: AgentDriverId('dsh') } })
    const first: TodoItem[] = [{ content: 'plan', status: 'pending' }]
    const latest: TodoItem[] = [
      { content: 'plan', status: 'completed' },
      { content: 'ship', status: 'in_progress' },
    ]

    expect(test.sessionProjections.snapshot(session).values.todos).toBeNull()
    session.append('todo/write', { todos: first })
    session.append('todo/write', { todos: latest })

    expect(test.sessionProjections.snapshot(session)).toEqual({
      asOfSeq: session.seq - 1,
      values: { todos: latest },
    })
  })

  it('clears on turn/start and remains visible after turn/end', async () => {
    const test = await harness()
    const session = test.sessions.create(undefined, { meta: { driverId: AgentDriverId('dsh') } })
    const completed: TodoItem[] = [{ content: 'done', status: 'completed' }]

    session.append('todo/write', { todos: completed })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(test.sessionProjections.snapshot(session).values.todos).toEqual(completed)

    session.append('turn/start', { turn: 2 })
    expect(test.sessionProjections.snapshot(session).values.todos).toBeNull()
  })

  it('rejects a duplicate producer and releases ownership on disposal', async () => {
    const test = new Context()
    ctx = test
    await test.plugin(SessionStore)
    await test.plugin(SessionProjectionRegistry)
    const first = await test.plugin(Todo)

    expect(() => { Todo.apply(test) }).toThrow('todo projection producer is already registered')
    await first.dispose()
    expect(() => { Todo.apply(test) }).not.toThrow()
  })
})
