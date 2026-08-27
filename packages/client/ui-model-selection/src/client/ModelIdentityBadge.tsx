import type { ModelSelectionIdentity } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelKey } from './locales.ts'
import css from './ModelIdentityBadge.module.css'

/** Compact identity presentation for one addressed DSH Session. */
export type ModelIdentityBadgeProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'model'>

function route(identity: ModelSelectionIdentity['selected'] | ModelSelectionIdentity['effective']): string {
  return identity === undefined ? '—' : `${identity.selection.provider} / ${identity.selection.model}`
}

function effort(identity: ModelSelectionIdentity['selected'] | ModelSelectionIdentity['effective']): string | undefined {
  return identity?.selection.reasoningEffort
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <span className={css.row} title={`${label}: ${value}`}>
      <span className={css.label}>{label}</span>
      <code>{value}</code>
    </span>
  )
}

/** Render Selected/Next turn/Effective and native/DSH identities without merging their names. */
export function ModelIdentityBadge({ useSession, t }: ModelIdentityBadgeProps) {
  const identity = useSession(snapshot => snapshot.modelSelection)
  if (identity === undefined) return null
  const selectedEffort = effort(identity.selected)
  const effectiveEffort = effort(identity.effective)
  return (
    <span className={css.root} data-testid="model-identity-badge">
      <IdentityRow label={t('identity.session')} value={String(identity.dshSessionId)} />
      {identity.selected !== undefined && <IdentityRow label={t('identity.selected')} value={route(identity.selected)} />}
      {selectedEffort !== undefined && <IdentityRow label={t('identity.effort')} value={selectedEffort} />}
      {identity.nextTurn !== undefined && <IdentityRow label={t('identity.nextTurn')} value={`${identity.nextTurn.provider} / ${identity.nextTurn.model}`} />}
      {identity.effective !== undefined && <IdentityRow label={t('identity.effective')} value={route(identity.effective)} />}
      {effectiveEffort !== undefined && <IdentityRow label={t('identity.effort')} value={effectiveEffort} />}
      {identity.native !== undefined && <IdentityRow label={t('identity.native')} value={`${identity.native.model}${identity.native.effort === undefined ? '' : ` · ${identity.native.effort}`}`} />}
      {identity.nativeConversationId !== undefined && (
        <IdentityRow label={t('identity.nativeConversation')} value={identity.nativeConversationId} />
      )}
    </span>
  )
}

export type ModelIdentityLocaleKey = ModelKey
