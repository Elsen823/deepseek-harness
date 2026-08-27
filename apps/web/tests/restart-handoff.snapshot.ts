// @vitest-environment jsdom
// Keyless assembled Web snapshot: the real client projection renders the
// logical DSH Session and resumed native-thread identity after reconnect.
import { join } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/restart-handoff/header.expected.txt')

installAssembledBootEnv()

it('renders logical Session and native Thread identities after handoff reconnect', async () => {
  mountAssembledApp('?fixture&fixtureHandoff=1')

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  const badge = await screen.findByTestId('model-identity-badge')
  const rows = [...badge.querySelectorAll(':scope > span')]
    .map(row => row.getAttribute('title') ?? '<missing>')
    .join('\n') + '\n'
  await expect(rows).toMatchFileSnapshot(EXPECTED)
  expect(rows).toContain('DSH Session: fx-alpha')
  expect(rows).toContain('Native conversation: fixture-native-thread-reconnected')
})
