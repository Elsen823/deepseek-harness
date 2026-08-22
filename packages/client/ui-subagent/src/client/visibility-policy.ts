/** Live subagent catalog visibility preference bound to Host settings. */

import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_SUBAGENT_VISIBILITY_SETTINGS,
  HIDE_INACTIVE_FIELD,
  type SubagentVisibilitySettings,
} from '../catalog-settings-contract.ts'

/** Browser preference owner shared by lineage catalogs and the Settings row. */
export class SubagentVisibilityPolicy {
  /** Reactive complete preference snapshot. */
  readonly settings: SnapshotStore<SubagentVisibilitySettings>
    = createSnapshotStore(DEFAULT_SUBAGENT_VISIBILITY_SETTINGS)

  /**
   * @param host - Durable settings scope; absent compositions keep defaults in memory.
   */
  constructor(private readonly host?: SettingsScope<SubagentVisibilitySettings>) {
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /**
   * Enable or disable inactive-agent filtering.
   * @param enabled - Next presentation preference.
   */
  setHideInactive(enabled: boolean): void {
    const current = this.settings.getSnapshot()
    if (current.hideInactive === enabled) return
    this.settings.set({ ...current, hideInactive: enabled })
    void this.host?.set(HIDE_INACTIVE_FIELD, enabled)
  }

  /** Adopt the accepted durable preference without writing it back. */
  private adopt(host: SettingsScope<SubagentVisibilitySettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    const current = this.settings.getSnapshot()
    if (current.hideInactive === section.hideInactive
      && current.inactiveAfterMinutes === section.inactiveAfterMinutes) return
    this.settings.set(section)
  }
}
