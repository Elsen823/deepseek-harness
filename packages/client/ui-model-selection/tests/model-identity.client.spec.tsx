// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import { NativeConversationId } from '@deepseek-ai/dsh-session'
import { ModelIdentityBadge } from '../src/client/ModelIdentityBadge.tsx'
import { en } from '../src/client/locales.ts'
import * as publicClient from '../src/client/index.ts'

const t: ComponentProps<typeof ModelIdentityBadge>['t'] = (key, params) => {
  const dictionary: Record<string, string> = en
  const template = dictionary[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match: string, name: string) => name in params ? String(params[name]) : match)
}

function snapshot(modelSelection?: ConversationSnapshot['modelSelection']): ConversationSnapshot {
  return { modelSelection, sessionId: 's1' as never } as unknown as ConversationSnapshot
}

afterEach(cleanup)

describe('ModelIdentityBadge', () => {
  it('keeps the identity presentation out of the public client entry', () => {
    expect(publicClient).not.toHaveProperty('ModelIdentityBadge')
  })

  it('distinguishes Selected, Next turn, Effective, Native, and DSH Session', () => {
    const value = snapshot({
      dshSessionId: 's1' as never,
      selected: { selection: { provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' }, source: 'user', seq: 3 },
      nextTurn: { provider: 'deepseek-official', model: 'pro', reasoningEffort: 'max' },
      effective: { selection: { provider: 'deepseek-official', model: 'flash', reasoningEffort: 'off' }, source: 'request/header', seq: 2 },
      native: { model: 'codex-flash', effort: 'high' },
      nativeConversationId: NativeConversationId('thread-1'),
    })
    render(<ModelIdentityBadge
      sessionId={'s1' as never}
      useSession={selector => selector(value)}
      useProjection={() => undefined}
      useSessions={() => ({}) as never}
      useWorkspaces={() => ({}) as never}
      useInput={selector => selector({} as never)}
      inputActions={{} as never}
      t={t}
    />)
    expect(screen.getByText('Selected')).toBeTruthy()
    expect(screen.getByText('Next turn')).toBeTruthy()
    expect(screen.getByText('Effective')).toBeTruthy()
    expect(screen.getByText('Native')).toBeTruthy()
    expect(screen.getByText('DSH Session')).toBeTruthy()
    expect(screen.getAllByText('Reasoning Effort')).toHaveLength(2)
    expect(screen.queryByText(/Reasoning Effort.*model/i)).toBeNull()
  })
})
