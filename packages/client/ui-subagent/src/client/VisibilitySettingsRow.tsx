/** General Settings toggle for inactive subagent presentation filtering. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentVisibilitySettings } from '../catalog-settings-contract.ts'
import type { SubagentKey } from './locales.ts'
import css from './VisibilitySettingsRow.module.css'

/** Registration-side preference face. */
export interface VisibilitySettingsRowInjected {
  hooks: {
    /** Persisted catalog preference bound as useVisibility. */
    visibility: SnapshotStore<SubagentVisibilitySettings>
  }
  /** Enable or disable age filtering. */
  setHideInactive: (enabled: boolean) => void
}

/** Full General Settings row props. */
export type VisibilitySettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'subagent'>
  & InjectFace<VisibilitySettingsRowInjected>

/**
 * Render the inactive-agent visibility toggle.
 * @param props - Composed Settings slot props.
 * @returns The preference row.
 */
export function VisibilitySettingsRow({
  useVisibility, setHideInactive, t,
}: VisibilitySettingsRowProps) {
  const settings = useVisibility(value => value)
  const stateKey: SubagentKey = settings.hideInactive
    ? 'settings.visibility.on'
    : 'settings.visibility.off'
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.visibility.title')}</div>
        <div className={css.desc}>{t('settings.visibility.description', {
          minutes: settings.inactiveAfterMinutes,
        })}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={settings.hideInactive}
        className={css.toggle}
        data-active={settings.hideInactive || undefined}
        onClick={() => { setHideInactive(!settings.hideInactive) }}
      >
        <span className={css.track} aria-hidden><span className={css.thumb} /></span>
        <span>{t(stateKey)}</span>
      </button>
    </div>
  )
}
