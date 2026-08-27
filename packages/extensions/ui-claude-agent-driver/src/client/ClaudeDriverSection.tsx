import { useEffect, useState, type ReactNode } from 'react'
import type { AgentDriverCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Business face supplied by the client runtime to the settings entry. */
export interface ClaudeDriverSectionInjected {
  /** Read the active Host Driver catalog. */
  list: () => Promise<AgentDriverCatalog>
}

/** Full settings-section props assembled by the slot renderer. */
export type ClaudeDriverSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.claudeDriver'>
  & InjectFace<ClaudeDriverSectionInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly catalog: AgentDriverCatalog }

/** Render the Host-owned Claude Driver status and native capability declaration. */
export function ClaudeDriverSection({ list, t }: ClaudeDriverSectionProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    void list().then(
      (catalog) => { if (current) setState({ status: 'ready', catalog }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [attempt, list])

  if (state.status === 'loading') return <section aria-busy="true"><p>{t('loading')}</p></section>
  if (state.status === 'error') {
    return (
      <section>
        <p role="alert">{t('error')}</p>
        <button type="button" onClick={() => { setState({ status: 'loading' }); setAttempt(value => value + 1) }}>{t('retry')}</button>
      </section>
    )
  }

  const claude = state.catalog.items.find(item => item.id === 'claude')
  return (
    <section data-agent-driver="claude" aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <p data-driver-status={claude === undefined ? 'inactive' : 'active'}>
        {claude === undefined ? t('missing') : t('active')}
      </p>
      <h3>{t('capabilities')}</h3>
      <ul>
        <li>{t('nativeOwnership')}</li>
        <li>{t('nativeOwnershipDetail')}</li>
      </ul>
      <h3>{t('unsupported')}</h3>
      <p>{t('unsupportedDetail')}</p>
      <p data-driver-reserved="grok">{t('grokReserved')}</p>
    </section>
  )
}
