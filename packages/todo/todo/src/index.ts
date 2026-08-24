/**
 * Portable Service Provider for the `todos` SessionProjection: a last-write-wins whole-list
 * Checklist that clears on `turn/start` and remains visible after `turn/end`.
 * @module @deepseek-ai/dsh-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { TodoItem } from '@deepseek-ai/dsh-session'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'todo'
/** The projection registry is the provider's only runtime dependency. */
export const inject = ['sessionProjections']

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()

const todosSchema = z.array(todoItemSchema).nullable()

const TODO_PRODUCER = Symbol.for('@deepseek-ai/dsh-todo/producer')

type ProducerSlot = SessionProjectionRegistry & { [TODO_PRODUCER]?: object | null }

/**
 * Register the sole `todos` projection producer for this registry.
 * @param ctx - registrant context carrying the projection registry.
 * @throws if another `@deepseek-ai/dsh-todo` producer already owns this registry.
 */
export function apply(ctx: Context): void {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) throw new Error('todo projection requires ctx.sessionProjections')
  const producerSlot = registry as ProducerSlot
  if (producerSlot[TODO_PRODUCER] != null) {
    throw new Error('todo projection producer is already registered')
  }
  const producer = {}
  producerSlot[TODO_PRODUCER] = producer
  try {
    registry.register<'todos', TodoItem[] | null>({
      key: 'todos',
      stateSchema: todosSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'todo/write') return event.data.todos
        if (event.type === 'turn/start') return null
        return state
      },
      wire: { viewSchema: todosSchema, view: state => state },
      stateVersion: 2,
    })
  } catch (error) {
    producerSlot[TODO_PRODUCER] = null
    throw error
  }
  ctx.effect(() => () => {
    if (producerSlot[TODO_PRODUCER] === producer) producerSlot[TODO_PRODUCER] = null
  }, 'todo projection producer ownership')
}
