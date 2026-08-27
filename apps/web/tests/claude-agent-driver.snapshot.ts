// @vitest-environment jsdom
// Assembled keyless Claude Driver coverage: the shipped Web bundle stays
// unchanged while this test opts into the dedicated provider/UI overlay and
// renders the real settings section against the FixtureApiClient catalog.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const OVERLAY = join(process.cwd(), 'apps/web/tests/claude-agent-driver.overlay.yml')
const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/claude-agent-driver/settings.expected.txt')

installAssembledBootEnv()

it('renders the opt-in Claude Driver management entry in the assembled Web surface', async () => {
  mountAssembledApp('?fixture&fixtureClaude=1', [OVERLAY])

  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }, { timeout: 10_000 }))
  const settings = await screen.findByRole('dialog', { name: 'Settings' })
  fireEvent.click(await within(settings).findByRole('button', { name: 'Claude Code' }))

  const section = await within(settings).findByRole('heading', { name: 'Claude Code Agent Driver' })
  const root = section.closest('section')
  if (root === null) throw new Error('Claude Driver settings section root missing')
  const snapshot = (root.textContent ?? '').replaceAll(/\s+/gu, ' ').trim()
  if (REFRESHING_GOLDEN) {
    mkdirSync(join(process.cwd(), 'apps/web/tests/snapshots/claude-agent-driver'), { recursive: true })
    writeFileSync(EXPECTED, snapshot)
  }
  await expect(snapshot).toMatchFileSnapshot(EXPECTED)
  expect(snapshot).toContain('Instructions, skills, tools, hooks, approvals, and execution remain owned by Claude Code.')
  expect(snapshot).toContain('Grok remains a reserved blank adapter.')
})
