import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { indexSubagentDescendants } from '../src/client/subagent-lineage.ts'
import { completeSubagentCatalog } from '../src/client/catalog-filter.ts'

const sid = (id: string): SessionId => id as SessionId

describe('UI Subagent descendant projection', () => {
  it('defaults the catalog filter to the complete retained presentation', () => {
    const root = sid('root')
    const child = { id: sid('child'), parentId: root, origin: 'subagent' as const, running: true }
    const catalogs = {} as never
    const summaries = { [child.id]: child } as never
    const result = completeSubagentCatalog({ rootSessionId: root, catalogs, summaries, now: 1 })
    expect(result.catalogs).toBe(catalogs)
    expect(result.summaries).toBe(summaries)
    expect(result.descendants.get(root)).toEqual({ count: 1, runningCount: 1 })
  })

  it('counts nested running descendants and stops at ordinary forks', () => {
    const owner = { id: sid('owner'), running: false }
    const child = { id: sid('child'), parentId: owner.id, origin: 'subagent' as const, running: false }
    const grandchild = { id: sid('grandchild'), parentId: child.id, origin: 'subagent' as const, running: true }
    const fork = { id: sid('fork'), parentId: child.id, running: false }
    const forkChild = { id: sid('fork-child'), parentId: fork.id, origin: 'subagent' as const, running: true }
    const result = indexSubagentDescendants(Object.fromEntries(
      [owner, child, grandchild, fork, forkChild].map(item => [item.id, item]),
    ))
    expect(result.get(owner.id)).toEqual({ count: 2, runningCount: 1 })
    expect(result.get(child.id)).toEqual({ count: 1, runningCount: 1 })
    expect(result.get(fork.id)).toEqual({ count: 1, runningCount: 1 })
  })

  it('terminates cycles and retains missing-parent aggregates', () => {
    const cycleA = { id: sid('a'), parentId: sid('b'), origin: 'subagent' as const, running: false }
    const cycleB = { id: sid('b'), parentId: sid('a'), origin: 'subagent' as const, running: false }
    const orphan = { id: sid('orphan'), parentId: sid('missing'), origin: 'subagent' as const, running: true }
    const result = indexSubagentDescendants({ [cycleA.id]: cycleA, [cycleB.id]: cycleB, [orphan.id]: orphan })
    expect(result.get(cycleA.id)?.count).toBe(2)
    expect(result.get(cycleB.id)?.count).toBe(2)
    expect(result.get(sid('missing'))).toEqual({ count: 1, runningCount: 1 })
  })
})
