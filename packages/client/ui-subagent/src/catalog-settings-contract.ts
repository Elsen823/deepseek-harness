/** Browser-safe presentation preference contract for the subagent catalog. */

/** Settings namespace owned by the Web subagent plugin. */
export const SUBAGENT_SETTINGS_NAMESPACE = 'ui-subagent'

/** Whether inactive catalog rows are age-filtered. */
export const HIDE_INACTIVE_FIELD = 'hideInactive'

/** Inactivity threshold in whole minutes. */
export const INACTIVE_AFTER_MINUTES_FIELD = 'inactiveAfterMinutes'

/** Largest timeout delay supported consistently by browser and Node timers. */
export const MAX_PORTABLE_TIMER_DELAY_MS = 2_147_483_647

/** Largest whole-minute threshold representable by one portable timer delay. */
export const MAX_INACTIVE_AFTER_MINUTES = Math.floor(MAX_PORTABLE_TIMER_DELAY_MS / 60_000)

/** Persisted subagent catalog visibility preferences. */
export interface SubagentVisibilitySettings {
  /** Hide non-running agents after the configured inactivity period. */
  hideInactive: boolean
  /** Whole minutes since the latest durable subagent activity event. */
  inactiveAfterMinutes: number
}

/** Default preserves the complete catalog until the user enables filtering. */
export const DEFAULT_SUBAGENT_VISIBILITY_SETTINGS: SubagentVisibilitySettings = {
  hideInactive: false,
  inactiveAfterMinutes: 60,
}
