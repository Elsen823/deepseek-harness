/** Browser settings entry for the Claude Agent Driver. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ClaudeDriverSection, type ClaudeDriverSectionInjected } from './ClaudeDriverSection.tsx'
import { DriverActivityView } from './DriverActivityView.tsx'
import { registerDriverActivityView } from './activity-view.ts'
import { en, zh, type ClaudeDriverLocaleKey } from './locales.ts'

export type { ClaudeDriverSectionInjected, ClaudeDriverSectionProps } from './ClaudeDriverSection.tsx'
export type { ClaudeDriverLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Claude Agent Driver settings copy. */
    'settings.claudeDriver': ClaudeDriverLocaleKey
  }
}

/** Client services required for the settings registration. */
export const inject = [
  'slots', 'locale', 'sessions', 'conversationEvents', 'conversationViews',
]

/** Register the Claude Driver settings and management entry. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.claudeDriver', { zh, en }), 'ui-claude-agent-driver: dictionaries')
  const list: ClaudeDriverSectionInjected['list'] = () => ctx.sessions.drivers()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'claude-driver',
    order: 30,
    locale: 'settings.claudeDriver',
    label: () => ctx.locale.bind('settings.claudeDriver')('nav'),
    inject: () => ({ list }),
  }, ClaudeDriverSection))
  registerDriverActivityView(ctx)
  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register({
      name: 'conversation.view',
      id: 'driver-activity',
      order: 20,
      locale: 'settings.claudeDriver',
      label: () => ctx.locale.bind('settings.claudeDriver')('activityTitle'),
    }, DriverActivityView)
  })
}
