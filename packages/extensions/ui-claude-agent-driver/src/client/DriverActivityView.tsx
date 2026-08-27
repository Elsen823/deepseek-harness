import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { EMPTY_DRIVER_ACTIVITY } from './activity-contract.ts'

/** Read-only native activity surface for one Driver-bound Session. */
export function DriverActivityView({ useSession, useSessions, sessionId, t }: ConvViewProps & PropsLocale<'settings.claudeDriver'>): ReactNode {
  const snapshot = useSession(state => state.views.get('driver-activity') ?? EMPTY_DRIVER_ACTIVITY)
  const summary = useSessions(state => state.byId[sessionId])
  const runtime = useSession(state => state.runtime)
  const model = useSession(state => state.modelSelection)
  const driverId = summary?.driverId ?? 'unknown'
  return (
    <section aria-label={t('activityTitle')} data-driver-activity="" data-read-only="true">
      <h2>{t('activityTitle')}</h2>
      <p>{t('activityReadOnly')}</p>
      <dl>
        <div><dt>{t('activitySession')}</dt><dd>{sessionId}</dd></div>
        <div><dt>{t('activityDriver')}</dt><dd>{String(driverId)}</dd></div>
        <div><dt>{t('activityNativeConversation')}</dt><dd>{model?.nativeConversationId ?? t('activityUnknown')}</dd></div>
        <div><dt>{t('activityStatus')}</dt><dd>{runtime?.activity ?? t('activityUnknown')}</dd></div>
      </dl>
      <h3>{t('activityHeading')}</h3>
      {snapshot.activities.length === 0
        ? <p>{t('activityEmpty')}</p>
        : (
          <ol>
            {snapshot.activities.map(node => (
              <li key={node.key} data-driver-activity-item={node.id}>
                <strong>{node.data.title ?? node.data.kind}</strong>
                <span>{node.data.phase}</span>
                {node.data.summary === undefined ? null : <p>{node.data.summary}</p>}
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}
