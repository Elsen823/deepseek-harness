import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  ConversationEventRegistry, ConversationViewRegistry, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDriverCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { ClaudeDriverSection } from '../src/client/ClaudeDriverSection.tsx'

async function bench(catalog: AgentDriverCatalog = {
  defaultId: 'dsh' as AgentDriverCatalog['defaultId'],
  items: [
    { id: 'dsh' as AgentDriverCatalog['defaultId'], name: 'DSH' },
    { id: 'claude' as AgentDriverCatalog['defaultId'], name: 'Claude Code' },
  ],
}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  ctx.provide('sessions', { drivers: vi.fn<() => Promise<AgentDriverCatalog>>().mockResolvedValue(catalog) })
  new ConversationEventRegistry(ctx)
  new ConversationViewRegistry(ctx)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.view': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

describe('Claude Agent Driver browser management entry', () => {
  it('declares the shared services and contributes a localized settings section', async () => {
    expect(inject).toEqual([
      'slots', 'locale', 'sessions', 'conversationEvents', 'conversationViews',
    ])
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ClaudeDriverSection)
    expect(entry.options).toMatchObject({ id: 'claude-driver', order: 30 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Claude Code')
    const injected = (entry.inject as unknown as () => { list: () => Promise<AgentDriverCatalog> })()
    await expect(injected.list()).resolves.toMatchObject({ items: [{ id: 'dsh' }, { id: 'claude' }] })

    b.locale.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe('Claude Code')
    await b.ctx.fiber.dispose()
  })

  it('keeps the entry explicit when the Host has not activated Claude', async () => {
    const b = await bench({ defaultId: 'dsh' as AgentDriverCatalog['defaultId'], items: [] })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    const injected = (entry.inject as unknown as () => { list: () => Promise<AgentDriverCatalog> })()
    await expect(injected.list()).resolves.toEqual({ defaultId: 'dsh', items: [] })
    await b.ctx.fiber.dispose()
  })

  it('contributes a read-only Driver Activity view through the shared conversation seams', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('conversation.view').find(row => row.options.id === 'driver-activity')
    expect(entry?.component).toBeDefined()
    expect(resolveSlotLabel(entry?.options.label)).toBe('Driver Activity')
    const views = b.ctx.get('conversationViews') as ConversationViewRegistry
    expect(views.entries().map(definition => definition.target)).toContain('driver-activity')

    await b.ctx.fiber.dispose()
    expect(views.entries()).toEqual([])
    expect(b.slots.entries('conversation.view')).toEqual([])
  })
})
