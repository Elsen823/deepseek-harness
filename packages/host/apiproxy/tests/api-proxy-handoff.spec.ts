import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { createProcessShutdown } from '../../../../apps/cli/src/process-shutdown.ts'

let nextRpc = 0

function request<P>(payload: P): RpcRequest<P> {
  nextRpc += 1
  return { rpcId: RpcId(`handoff-${String(nextRpc)}`), payload }
}

describe('ApiProxy restart generation fencing', () => {
  it('returns the production restart response before the launcher starts ordinary teardown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-production-restart-'))
    const order: string[] = []
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(AgentRegistry, {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const originalHandoff = ctx.agents.restartHandoff.bind(ctx.agents)
      const handoff = vi.fn(() => originalHandoff({ generation: 'production-generation' }))
      const dispose = vi.fn(async () => { order.push('dispose') })
      const shutdown = createProcessShutdown(dispose, vi.fn(), vi.fn(), 100, async () => {
        order.push('handoff')
        await handoff()
      })
      // This is the same launcher-to-app service path used by profile boot:
      // the gateway receives ctx.appRestart, not a direct registry callback.
      provideCmdline(ctx, { args: [], exit: () => {}, restart: code => shutdown.restart(code) })
      const api = createApiProxy(ctx, {
        defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
        cwd: '/tmp',
        ...(ctx.appRestart === undefined ? {} : { restart: ctx.appRestart }),
      })
      const response = await toFetchHandler(api).fetch(new Request('http://dsh.internal/api/host.restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'production-restart',
          method: 'host.restart',
          payload: {},
        }),
      }))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        rpcId: 'production-restart',
        result: { ok: true, value: { accepted: true } },
      })
      expect(handoff).toHaveBeenCalledOnce()
      expect(order).toEqual(['handoff'])
      expect(dispose).not.toHaveBeenCalled()

      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await shutdown.shutdown(0)
      expect(order).toEqual(['handoff', 'dispose'])
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('invokes the explicit process restart controller without admitting itself', async () => {
    const ctx = new Context()
    const restart = vi.fn(async () => {})
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
      cwd: '/tmp',
      restart,
    })

    await expect(api.host.restart(request({}))).resolves.toMatchObject({
      result: { ok: true, value: { accepted: true } },
    })
    expect(restart).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('reports a refused process restart as retryable and leaves the callback in control', async () => {
    const ctx = new Context()
    const restart = vi.fn(async () => { throw new Error('turn did not quiesce') })
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
      cwd: '/tmp',
      restart,
    })

    await expect(api.host.restart(request({}))).resolves.toMatchObject({
      result: {
        ok: false,
        error: { code: 'agent-busy', details: { reason: 'restart-handoff-refused' } },
      },
    })
    expect(restart).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('returns a retryable response for an admitted request crossing the handoff barrier', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-handoff-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(AgentRegistry, {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const listed = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      ctx.provide('sessionPersistence', {
        list: async () => {
          listed.resolve(undefined)
          await release.promise
          return []
        },
      } as never)
      const api = createApiProxy(ctx, {
        defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
        cwd: '/tmp',
      })

      const listing = api.sessions.list(request({}))
      await listed.promise
      const handoff = ctx.agents.restartHandoff({ generation: 'api-generation-1' })
      expect(ctx.agents.restartHandoffPhase).toBe('requested')
      let handoffSettled = false
      void handoff.then(() => { handoffSettled = true })
      await Promise.resolve()
      expect(handoffSettled).toBe(false)
      release.resolve(undefined)

      const response = await listing
      expect(response.result).toMatchObject({
        ok: false,
        error: {
          code: 'agent-busy',
          details: { reason: 'restart-handoff-requested' },
        },
      })
      await expect(handoff).resolves.toMatchObject({ generation: 'api-generation-1', records: [] })
      expect(ctx.agents.restartHandoffPhase).toBe('committed')
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('maps an admitted request rejection crossing the handoff barrier to retryable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-handoff-rejection-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(AgentRegistry, {
        restartHandoff: { directory, quiescenceTimeoutMs: 100, leaseTimeoutMs: 10_000 },
      })
      const listed = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      ctx.provide('sessionPersistence', {
        list: async () => {
          listed.resolve(undefined)
          await release.promise
          throw new Error('persistence closed during generation change')
        },
      } as never)
      const api = createApiProxy(ctx, {
        defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
        cwd: '/tmp',
      })

      const listing = api.sessions.list(request({}))
      await listed.promise
      const handoff = ctx.agents.restartHandoff({ generation: 'api-rejection-generation-1' })
      release.resolve(undefined)

      await expect(listing).resolves.toMatchObject({
        result: {
          ok: false,
          error: {
            code: 'agent-busy',
            details: { reason: 'restart-handoff-requested' },
          },
        },
      })
      await expect(handoff).resolves.toMatchObject({ generation: 'api-rejection-generation-1', records: [] })
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
