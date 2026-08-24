/**
 * Portable Checklist projection types and the `todos` projection-key declaration.
 * @module @deepseek-ai/dsh-todo/types
 */

import type { TodoItem } from '@deepseek-ai/dsh-session/types'

export type { TodoItem } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    todos: TodoItem[] | null
  }
  interface SessionProjectionMap {
    /** Current whole Checklist, or `null` before a write and after the next turn starts. */
    todos: TodoItem[] | null
  }
}
