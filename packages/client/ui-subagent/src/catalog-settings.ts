/** Host schema for durable subagent catalog presentation preferences. */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SUBAGENT_VISIBILITY_SETTINGS,
  HIDE_INACTIVE_FIELD,
  INACTIVE_AFTER_MINUTES_FIELD,
  MAX_INACTIVE_AFTER_MINUTES,
  type SubagentVisibilitySettings,
} from './catalog-settings-contract.ts'

export {
  DEFAULT_SUBAGENT_VISIBILITY_SETTINGS,
  HIDE_INACTIVE_FIELD,
  INACTIVE_AFTER_MINUTES_FIELD,
  MAX_INACTIVE_AFTER_MINUTES,
  SUBAGENT_SETTINGS_NAMESPACE,
  type SubagentVisibilitySettings,
} from './catalog-settings-contract.ts'

/** Host settings schema shared with the browser scope. */
export const SubagentVisibilitySettingsSchema: z<SubagentVisibilitySettings> = z.object({
  [HIDE_INACTIVE_FIELD]: z.boolean().default(DEFAULT_SUBAGENT_VISIBILITY_SETTINGS.hideInactive),
  [INACTIVE_AFTER_MINUTES_FIELD]: z.natural().min(1).max(MAX_INACTIVE_AFTER_MINUTES)
    .default(DEFAULT_SUBAGENT_VISIBILITY_SETTINGS.inactiveAfterMinutes),
})
