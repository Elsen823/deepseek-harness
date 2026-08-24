/**
 * Source-path resolution is the subject: query-qualified source URLs create
 * distinct module instances without requiring built output.
 */

import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'

type ScopeApi = typeof import('@deepseek-ai/dsh-scope')

async function loadScopeInstance(name: string): Promise<ScopeApi> {
  const url = new URL('../src/index.ts', import.meta.url)
  url.searchParams.set('instance', name)
  return import(url.href) as Promise<ScopeApi>
}

it('shares tags, parent links, and carriers across module instances', async () => {
  const first = await loadScopeInstance('first')
  const second = await loadScopeInstance('second')
  const ctx = new Context()
  const agent = { name: 'agent' }
  const firstPreset = { name: 'first-preset' }
  const secondPreset = { name: 'second-preset' }
  const scope = first.createScope(ctx, agent)
  const cleanup = Promise.withResolvers<undefined>()
  let cleanupFinished = false
  scope.ctx.effect(() => async () => {
    await cleanup.promise
    cleanupFinished = true
  })

  expect(second.scopeOf(scope.ctx)).toBe(agent)

  const binding = second.bindScopeParent(agent, firstPreset)
  expect(first.scopeParentOf(agent)).toBe(firstPreset)
  expect(first.scopeChainOf(agent)).toEqual([agent, firstPreset])
  binding.rebind(secondPreset)
  expect(first.scopeParentOf(agent)).toBe(secondPreset)

  const firstCarrier = first.scopeTarget({}, agent)
  expect(second.isScopeCarrier(firstCarrier)).toBe(true)
  expect(second.carrierKeyOf(firstCarrier)).toBe(agent)
  const secondCarrier = second.scopeTarget({}, agent)
  expect(first.isScopeCarrier(secondCarrier)).toBe(true)
  expect(first.carrierKeyOf(secondCarrier)).toBe(agent)

  let disposeFinished = false
  const dispose = scope.dispose().then(() => { disposeFinished = true })
  await Promise.resolve()
  expect(disposeFinished).toBe(false)
  expect(cleanupFinished).toBe(false)
  cleanup.resolve(undefined)
  await dispose
  expect(cleanupFinished).toBe(true)
})

it('rejects an incompatible shared runtime revision at module load', async () => {
  const runtimeSlot = Symbol.for('@deepseek-ai/dsh-scope/runtime')
  const runtimeGlobal = globalThis as Record<symbol, unknown>
  const current = runtimeGlobal[runtimeSlot]
  runtimeGlobal[runtimeSlot] = { revision: 0 }
  try {
    await expect(loadScopeInstance('incompatible')).rejects.toThrow(/incompatible shared runtime revision/)
  } finally {
    runtimeGlobal[runtimeSlot] = current
  }
})
