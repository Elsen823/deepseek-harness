import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { createModelSelectionOwner, type Agent, type AgentDriver } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { AgentDriverId, SessionId, type Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { expect, it } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'

type ScopeApi = typeof import('@deepseek-ai/dsh-scope')

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('driver-preset'), payload }
}

async function duplicateScopeApi(): Promise<ScopeApi> {
  // Source-path resolution is the subject. This intentional cross-package src URL
  // creates a second clean-tree module beside the Host's tsconfig-paths imports.
  const url = new URL('../../../core/scope/src/index.ts', import.meta.url)
  url.searchParams.set('instance', 'external-driver')
  return import(url.href) as Promise<ScopeApi>
}

function registerDriver(ctx: Context, scopeApi: ScopeApi, id: string, scoped: boolean): void {
  const driverId = AgentDriverId(id)
  const driver: AgentDriver = {
    info: { id: driverId, name: `Driver ${id}` },
    prepare(session: Session) {
      const agent = { id: session.id, session, modelSelection: createModelSelectionOwner(session), status: 'idle' } as unknown as Agent
      const scope = scoped ? scopeApi.createScope(ctx, agent) : undefined
      Object.assign(agent, { ctx: (scope?.ctx ?? ctx).extend({ agent }) })
      return {
        agent,
        start() {},
        dispose: async () => { await scope?.dispose() },
      }
    },
  }
  ctx.agents.registerDriver(driver)
}

async function harness(): Promise<{ api: ReturnType<typeof createApiProxy>; ctx: Context; root: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-driver-preset-')))
  const presetDir = join(root, 'presets', 'standard')
  const plugin = join(root, 'preset-marker.mjs')
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(plugin, "export const name = 'preset-marker'\nexport function apply() {}\n")
  writeFileSync(join(presetDir, 'agent.cordis.yml'), `- id: marker\n  name: ${JSON.stringify(plugin)}\n`)

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: join(root, 'presets'), trust: 'system' }],
    includeUserRoot: false,
  })
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, ctx, root }
}

it('creates a preset-composed Session through a Driver using another scope module instance', async () => {
  const { api, ctx, root } = await harness()
  try {
    const scopeApi = await duplicateScopeApi()
    registerDriver(ctx, scopeApi, 'codex', true)

    const response = await api.sessions.create(request({
      sessionId: SessionId('mixed-driver'),
      driverId: AgentDriverId('codex'),
    }))

    expect(response.result).toMatchObject({
      ok: true,
      value: { sessionId: 'mixed-driver', driverId: 'codex', agentPreset: 'standard' },
    })
    const agent = ctx.agents.get(SessionId('mixed-driver'))
    if (agent === undefined) throw new Error('expected the Agent to be published')
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    expect(agent.session.header.driverId).toBe(AgentDriverId('codex'))
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back a Driver that returns an unscoped Agent Context', async () => {
  const { api, ctx, root } = await harness()
  try {
    registerDriver(ctx, await duplicateScopeApi(), 'unscoped', false)

    const response = await api.sessions.create(request({
      sessionId: SessionId('unscoped-driver'),
      driverId: AgentDriverId('unscoped'),
    }))

    if (response.result.ok) throw new Error('expected unscoped Agent creation to fail')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toContain('refusing to compose an unscoped context')
    expect(ctx.agents.get(SessionId('unscoped-driver'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('unscoped-driver'))).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
