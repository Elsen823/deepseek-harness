import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_SUBAGENT_VISIBILITY_SETTINGS, MAX_INACTIVE_AFTER_MINUTES,
  SUBAGENT_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-subagent'

const MAX_PORTABLE_TIMER_DELAY_MS = 2_147_483_647

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-subagent host', () => {
  it('registers, validates, and disposes the catalog visibility preference', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(SUBAGENT_SETTINGS_NAMESPACE)

    expect(ctx.settings.get(ns)).toEqual(DEFAULT_SUBAGENT_VISIBILITY_SETTINGS)
    await ctx.settings.update(ns, { hideInactive: true, inactiveAfterMinutes: 120 })
    expect(ctx.settings.get(ns)).toEqual({ hideInactive: true, inactiveAfterMinutes: 120 })
    const maxPortableMinutes = Math.floor(MAX_PORTABLE_TIMER_DELAY_MS / 60_000)
    expect(MAX_INACTIVE_AFTER_MINUTES).toBe(maxPortableMinutes)
    await ctx.settings.update(ns, { inactiveAfterMinutes: maxPortableMinutes })
    await expect(ctx.settings.update(ns, {
      inactiveAfterMinutes: maxPortableMinutes + 1,
    })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { inactiveAfterMinutes: 0 })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })
})
