import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionRuntimeRegistry from '@deepseek-ai/dsh-session-runtime'
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeDriverConfig, ClaudeQueryFactory } from '../src/driver.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  CLAUDE_AGENT_DRIVER_ID,
  ClaudeAgent,
  ClaudeAgentDriver,
  ClaudeModelRouteMapper,
  ClaudeModelSelectionError,
  observeClaudeSession,
} from '../src/index.ts'

const config: ClaudeDriverConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  aliases: Object.freeze({ sonnet: 'claude-sonnet-4-6' }),
  supportedModels: Object.freeze([]),
  supportedEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  permissionMode: 'dontAsk',
}

function sdkInit(sessionId: string): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId } as SDKMessage
}

function sdkAssistant(): SDKMessage {
  return {
    type: 'assistant',
    session_id: 'native-1',
    message: {
      content: [{ type: 'tool_use', name: 'Bash' }],
      usage: { input_tokens: 3, output_tokens: 5 },
    },
  } as unknown as SDKMessage
}

function sdkResult(text: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: 3, output_tokens: 5 },
    session_id: 'native-1',
  } as unknown as SDKMessage
}

function queryFrom(messages: readonly SDKMessage[], onClose = vi.fn()): Query {
  const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
    yield* messages
  })()
  return Object.assign(stream, {
    interrupt: () => Promise.resolve(undefined),
    close: onClose,
  }) as unknown as Query
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function factoryFor(
  messages: readonly SDKMessage[],
): { factory: ClaudeQueryFactory; calls: Array<{ prompt: string; options: Options }> } {
  const calls: Array<{ prompt: string; options: Options }> = []
  const factory: ClaudeQueryFactory = (params) => {
    calls.push(params)
    return queryFrom(messages)
  }
  return { factory, calls }
}

describe('Claude model route mapper', () => {
  it('maps provider, alias, and effort to native Claude settings', () => {
    const mapper = new ClaudeModelRouteMapper(config)
    expect(mapper.map({ provider: 'anthropic', model: 'sonnet', reasoningEffort: 'high' as never })).toEqual({
      selected: { provider: 'anthropic', model: 'sonnet', reasoningEffort: 'high' },
      nativeModel: 'claude-sonnet-4-6',
      nativeEffort: 'high',
    })
  })

  it('reports each unrepresentable selection explicitly', () => {
    const mapper = new ClaudeModelRouteMapper(config)
    for (const selection of [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'anthropic', model: 'gpt-5' },
      { provider: 'anthropic', model: 'sonnet', reasoningEffort: 'unsupported' as never },
    ]) {
      expect(() => mapper.map(selection)).toThrow(ClaudeModelSelectionError)
    }
  })
})

describe('Claude Agent Driver', () => {
  it('registers an opaque management contribution through the shared seam', async () => {
    const ctx = await harness()
    const agents = ctx.agents
    await ctx.plugin({ name: 'claude-driver', inject: ['agents'], apply }, {})

    expect(ctx.agents.getDriver(CLAUDE_AGENT_DRIVER_ID)).toEqual({
      id: CLAUDE_AGENT_DRIVER_ID,
      name: 'Claude Code',
    })
    const contribution = ctx.agents.listDriverContributions(CLAUDE_AGENT_DRIVER_ID)[0]
    expect(contribution).toMatchObject({ id: 'claude-code-settings', kind: 'settings' })
    expect(contribution?.value).toMatchObject({ native: 'claude-code', nativeHooks: true })

    await ctx.fiber.dispose()
    expect(agents.listDriverContributions(CLAUDE_AGENT_DRIVER_ID)).toEqual([])
  })

  it('drives direct Chat through native query and records identity, activity, and timeline facts', async () => {
    const ctx = await harness()
    const { factory, calls } = factoryFor([sdkInit('native-1'), sdkAssistant(), sdkResult('native answer')])
    let initiatorAtQuery: unknown
    const observedFactory: ClaudeQueryFactory = (params) => {
      initiatorAtQuery = ctx.agents.currentInitiator()
      return factory(params)
    }
    const driver = new ClaudeAgentDriver(ctx, config, observedFactory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({
      sessionId: SessionId('claude-chat'),
      driverId: CLAUDE_AGENT_DRIVER_ID,
    })

    handle.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'ignored context' }], source: { kind: 'plugin', plugin: 'test' } }))
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello Claude' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    expect(calls).toHaveLength(1)
    expect(initiatorAtQuery).toBe(handle.agent)
    expect(calls[0]?.prompt).toBe('hello Claude')
    expect(calls[0]?.options).toMatchObject({ model: 'claude-sonnet-4-6', permissionMode: 'dontAsk' })
    const request = handle.agent.session.events.find(event => event.type === 'agent-driver/model-request')
    expect(request?.type === 'agent-driver/model-request' ? request.data.driver?.payload : undefined).toMatchObject({
      prompt: 'hello Claude',
      nativeOptions: {
        model: 'claude-sonnet-4-6',
        permissionMode: 'dontAsk',
      },
    })
    expect((handle.agent as ClaudeAgent).nativeConversationId).toBe('native-1')
    expect(handle.agent.status).toBe('idle')
    expect(handle.agent.session.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'agent-driver/activation',
      'user/message',
      'agent-driver/model-request',
      'agent-driver/model-attempt',
      'agent-driver/activity',
      'agent-driver/checkpoint',
      'assistant/message',
      'turn/end',
    ]))
    expect(handle.agent.session.events.find(event => event.type === 'assistant/message')?.data.message.content)
      .toEqual([{ type: 'text', text: 'native answer' }])
    expect(observeClaudeSession(handle.agent.session)).toMatchObject({
      sessionId: SessionId('claude-chat'),
      driverId: CLAUDE_AGENT_DRIVER_ID,
      nativeConversationId: 'native-1',
      activities: 1,
      status: 'active',
    })

    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('queues steering during an active native query as exactly one next turn', async () => {
    const ctx = await harness()
    let markFirstQueryActive!: () => void
    const firstQueryActive = new Promise<void>((resolve) => { markFirstQueryActive = resolve })
    let releaseFirstQuery!: () => void
    const firstQueryRelease = new Promise<void>((resolve) => { releaseFirstQuery = resolve })
    const calls: Array<{ prompt: string; options: Options }> = []
    const factory: ClaudeQueryFactory = (params) => {
      calls.push(params)
      if (calls.length === 1) {
        const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
          yield sdkInit('native-steering')
          markFirstQueryActive()
          await firstQueryRelease
          yield sdkResult('first native answer')
        })()
        return Object.assign(stream, {
          interrupt: () => Promise.resolve(undefined),
          close: vi.fn(),
        }) as unknown as Query
      }
      return queryFrom([sdkInit('native-steering'), sdkResult('steering answer')])
    }
    const driver = new ClaudeAgentDriver(ctx, config, factory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({ sessionId: SessionId('claude-steering'), driverId: CLAUDE_AGENT_DRIVER_ID })
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'start native query' }],
        source: { kind: 'user' },
      }))
      await firstQueryActive

      handle.agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'steer during active Claude query' }],
        source: { kind: 'user' },
      }))
      expect(handle.agent.inbox.nextStep).toHaveLength(0)

      releaseFirstQuery()
      await handle.agent.whenIdle()

      expect(calls).toHaveLength(2)
      expect(calls[1]?.prompt).toBe('steer during active Claude query')
      expect(handle.agent.inbox.nextStep).toHaveLength(0)
      expect(handle.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    } finally {
      releaseFirstQuery()
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('resumes the native conversation identity without issuing DSH context', async () => {
    const ctx = await harness()
    const first = factoryFor([sdkInit('native-1'), sdkResult('first')])
    const driver = new ClaudeAgentDriver(ctx, config, first.factory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({ sessionId: SessionId('claude-resume'), driverId: CLAUDE_AGENT_DRIVER_ID })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await handle.dispose()

    const second = factoryFor([sdkInit('native-1'), sdkResult('resumed')])
    const resumedDriver = new ClaudeAgentDriver(ctx, config, second.factory)
    const prepared = resumedDriver.prepare(handle.agent.session, {}, new AbortController().signal)
    prepared.start('resume')
    prepared.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await prepared.agent.whenIdle()

    expect(second.calls[0]?.options).toMatchObject({ resume: 'native-1' })
    expect(second.calls[0]?.options).not.toHaveProperty('sessionId')
    expect(prepared.agent.session.events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content)
      .toEqual([{ type: 'text', text: 'resumed' }])
    await prepared.dispose()
    await ctx.fiber.dispose()
  })

  it('records cancellation and leaves the native query as the execution owner', async () => {
    const ctx = await harness()
    let queryStarted!: () => void
    const started = new Promise<void>((resolve) => { queryStarted = resolve })
    const factory: ClaudeQueryFactory = ({ options }) => {
      const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
        yield sdkInit('native-cancel')
        queryStarted()
        await new Promise<void>((resolve) => {
          options.abortController?.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })()
      return Object.assign(stream, {
        interrupt: () => Promise.resolve(undefined),
        close: vi.fn(),
      }) as unknown as Query
    }
    const driver = new ClaudeAgentDriver(ctx, config, factory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({ sessionId: SessionId('claude-cancel'), driverId: CLAUDE_AGENT_DRIVER_ID })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel me' }], source: { kind: 'user' } }))
    await started
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    expect(handle.agent.session.events.find(event => event.type === 'agent-driver/model-attempt')?.data.outcome)
      .toBe('aborted')
    expect(handle.agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('owns maintenance through cancellation, idle observation, and disposal', async () => {
    const ctx = await harness()
    const { factory } = factoryFor([sdkInit('native-maintenance'), sdkResult('unused')])
    const driver = new ClaudeAgentDriver(ctx, config, factory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({ sessionId: SessionId('claude-maintenance'), driverId: CLAUDE_AGENT_DRIVER_ID })
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let idle = false
    const maintenance = handle.agent.runMaintenance(async (signal) => {
      started.resolve(undefined)
      await release.promise
      return signal.aborted
    })
    await started.promise
    const idleWait = handle.agent.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    handle.agent.cancel({ kind: 'user' })
    expect((await Promise.race([
      maintenance.then(value => value),
      Promise.resolve('pending' as const),
    ]))).toBe('pending')
    release.resolve(undefined)
    await expect(maintenance).resolves.toBe(true)
    await idleWait
    expect(idle).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('projects native approval and user-input attention while preserving native callbacks', async () => {
    const ctx = await harness()
    await ctx.plugin(SessionRuntimeRegistry)
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }))
    const onElicitation = vi.fn(async () => ({ action: 'accept' as const }))
    const interactionConfig: ClaudeDriverConfig = { ...config, canUseTool, onElicitation }
    const { factory, calls } = factoryFor([sdkInit('native-attention'), sdkResult('done')])
    const driver = new ClaudeAgentDriver(ctx, interactionConfig, factory)
    ctx.agents.registerDriver(driver)
    const handle = await ctx.agents.create({ sessionId: SessionId('claude-attention'), driverId: CLAUDE_AGENT_DRIVER_ID })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'attention' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    const options = calls[0]?.options
    if (options?.canUseTool === undefined || options.onElicitation === undefined) {
      throw new Error('Claude native interaction callbacks were not installed')
    }
    const signal = new AbortController().signal
    const runtime = () => ctx.sessionRuntimes.get(SessionId('claude-attention'))
    const approval = options.canUseTool('Bash', {}, {
      signal,
      toolUseID: 'tool-1',
      requestId: 'approval-1',
    })
    expect(runtime()?.attention.approvals).toBe(1)
    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    expect(runtime()?.attention.approvals).toBe(0)
    const input = options.onElicitation({ serverName: 'mcp', message: 'value' }, { signal })
    expect(runtime()?.attention.userInputs).toBe(1)
    await expect(input).resolves.toEqual({ action: 'accept' })
    expect(runtime()?.attention.userInputs).toBe(0)
    expect(canUseTool).toHaveBeenCalledOnce()
    expect(onElicitation).toHaveBeenCalledOnce()
    await handle.dispose()
    await ctx.fiber.dispose()
  })
})
