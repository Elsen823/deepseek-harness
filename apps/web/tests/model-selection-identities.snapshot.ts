// @vitest-environment jsdom
// Assembled keyless model-selection identity snapshot: the real built client
// reads durable Selected and Effective evidence from the FixtureApiClient and
// renders the Session-local header badge without a model or network call.
import { join } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/model-selection-identities/header.expected.txt')

installAssembledBootEnv()

it('renders Selected, Next turn, Effective, and DSH Session identities in the assembled header', async () => {
  mountAssembledApp('?fixture&fixtureModelIdentity=1')

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  const badge = await screen.findByTestId('model-identity-badge')
  const rows = [...badge.querySelectorAll(':scope > span')]
    .map(row => row.getAttribute('title') ?? '<missing>')
    .join('\n') + '\n'
  await expect(rows).toMatchFileSnapshot(EXPECTED)
})
