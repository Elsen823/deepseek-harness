/** Host registration for durable browser subagent catalog preferences. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SUBAGENT_SETTINGS_NAMESPACE, SubagentVisibilitySettingsSchema,
} from './catalog-settings.ts'

export {
  DEFAULT_SUBAGENT_VISIBILITY_SETTINGS,
  HIDE_INACTIVE_FIELD,
  INACTIVE_AFTER_MINUTES_FIELD,
  MAX_INACTIVE_AFTER_MINUTES,
  SUBAGENT_SETTINGS_NAMESPACE,
  type SubagentVisibilitySettings,
} from './catalog-settings.ts'

/**
 * Register durable subagent catalog preferences when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(SUBAGENT_SETTINGS_NAMESPACE),
      SubagentVisibilitySettingsSchema,
    )
  })
}
