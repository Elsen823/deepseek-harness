// Keyless Chromium coverage for the assembled model-selection surfaces. Each
// case boots the shipped Loader composition and uses the real HTTP/SSE server;
// the local provider rows are deterministic and no external model is needed.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/model-selection-identities', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const TWO_SESSIONS_EXPECTED = join(SNAPSHOT_DIR, 'two-sessions.expected.md')
const RELOAD_EXPECTED = join(SNAPSHOT_DIR, 'reload-before-use.expected.md')
const FAILURE_EXPECTED = join(SNAPSHOT_DIR, 'provider-failure.expected.md')
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running-turn.expected.md')

interface TestContext {
  settings: { update(namespace: unknown, value: unknown): Promise<void> }
}

interface WebScaffold {
  baseUrl: string
  ctx: TestContext
  workspaceCwd: string
  whenTurnSettled(timeoutMs?: number): Promise<SessionId>
  close(): Promise<void>
}

interface ScaffoldModule {
  launchWebScaffold(options?: Record<string, unknown>): Promise<WebScaffold>
  seedSession(scaffold: WebScaffold, fixtureText: string, id: string): Promise<SessionId>
  acknowledgeReloadConnectionLoss(tripwire: { warnings: string[]; pageErrors: string[] }, warningStart: number): void
  captureStableAria(page: Page, selector: string, workspaceCwd: string): Promise<string>
  compareOrRefreshGolden(path: string, actual: string, mode: 'replay' | 'record' | 'refresh'): Promise<void>
  watchConsole(page: Page): { warnings: string[]; pageErrors: string[] }
  webSnapshotMode(): 'replay' | 'record' | 'refresh'
}

const PROVIDERS = {
  'origin-gateway': {
    displayName: 'Origin Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.origin.example/v1',
    models: [{ id: 'origin-large', name: 'Origin Large' }],
  },
  'acme-gateway': {
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.acme.example/v1',
    models: [{ id: 'acme-large', name: 'Acme Large' }],
  },
} as const

const FAILURE_ROUTES = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
  },
  {
    id: 'recovery-gateway',
    name: 'Recovery Gateway',
    models: [{ id: 'recovery-large', name: 'Recovery Large' }],
  },
  {
    id: 'unavailable-gateway',
    name: 'Unavailable Gateway',
    models: [{ id: 'unavailable-large', name: 'Unavailable Large' }],
    listModelsFailure: 'catalog endpoint is unavailable',
  },
] as const

const RUNNING_REPLAY_PROVIDERS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
  },
  {
    id: 'acme-gateway',
    name: 'Acme Gateway',
    models: [{ id: 'acme-large', name: 'Acme Large' }],
  },
] as const

describe('web e2e: model-selection identities', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: { warnings: string[]; pageErrors: string[] } | undefined
  let scaffoldApi: ScaffoldModule | undefined
  let sidecarDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    scaffold = undefined
    if (sidecarDir !== undefined) await rm(sidecarDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    sidecarDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'model-selection-identities teardown failed')
  })

  async function boot(
    scaffoldOptions: Record<string, unknown> = {},
    settingsProviders: unknown = PROVIDERS,
    sessionIds: readonly string[] = ['model-identities-a', 'model-identities-b'],
  ): Promise<void> {
    // Keep the host-plane scaffold out of the Client TypeScript aggregate;
    // Vitest still loads the exact same module at runtime for this Chromium lane.
    const loadedScaffold: unknown = await import(new URL('./scaffold.ts', import.meta.url).href)
    scaffoldApi = loadedScaffold as ScaffoldModule
    scaffold = await scaffoldApi.launchWebScaffold(scaffoldOptions)
    if (settingsProviders !== undefined) {
      await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: settingsProviders })
    }
    const fixture = await readFile(SEED, 'utf8')
    for (const id of sessionIds) await scaffoldApi.seedSession(scaffold, fixture, id)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = scaffoldApi.watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }

  async function selectModel(modelName: string): Promise<void> {
    if (page === undefined) throw new Error('model-selection-identities page is not booted')
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    await page.getByRole('menuitemradio', { name: modelName, exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 15_000 })
      .toBe(`Select model, current ${modelName}`)
  }

  async function identitySnapshot(): Promise<string> {
    if (page === undefined || scaffold === undefined) throw new Error('model-selection-identities page is not booted')
    return await scaffoldApi!.captureStableAria(page, '[data-testid="model-identity-badge"]', scaffold.workspaceCwd)
  }

  async function openSeededRows(): Promise<{ first: ReturnType<Page['locator']>; second: ReturnType<Page['locator']> }> {
    if (page === undefined) throw new Error('model-selection-identities page is not booted')
    const groupRow = page.locator('[role="treeitem"][aria-expanded]').first()
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const sessionRows = page.locator('[role="treeitem"]')
    return { first: sessionRows.nth(1), second: sessionRows.nth(2) }
  }

  it('keeps independent selections in two concurrent Sessions', async () => {
    await boot()
    onTestFailed(() => page === undefined ? undefined : saveFailureShot(page, 'web-e2e-model-selection-two-sessions'))
    await page!.reload({ waitUntil: 'load' })
    await page!.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const { first: firstRow, second: secondRow } = await openSeededRows()

    await firstRow.click()
    await selectModel('Acme Large')
    await firstRow.click()
    const firstSnapshot = await identitySnapshot()

    await secondRow.click()
    await selectModel('Origin Large')
    await secondRow.click()
    const secondSnapshot = await identitySnapshot()

    await firstRow.click()
    await expect.poll(
      () => page!.getByRole('button', { name: 'Select model, current Acme Large' }).isVisible(),
      { timeout: 15_000 },
    ).toBe(true)
    const firstRestored = await identitySnapshot()

    await secondRow.click()
    await expect.poll(
      () => page!.getByRole('button', { name: 'Select model, current Origin Large' }).isVisible(),
      { timeout: 15_000 },
    ).toBe(true)
    const secondRestored = await identitySnapshot()

    await scaffoldApi!.compareOrRefreshGolden(
      TWO_SESSIONS_EXPECTED,
      `## First Session after its selection\n\n${firstSnapshot}\n\n`
        + `## Second Session after its selection\n\n${secondSnapshot}\n\n`
        + `## First Session after switching away and back\n\n${firstRestored}\n\n`
        + `## Second Session after switching away and back\n\n${secondRestored}`,
      scaffoldApi!.webSnapshotMode(),
    )
    expect(tripwire!.pageErrors).toEqual([])
    expect(tripwire!.warnings).toEqual([])
  }, 90_000)

  it('restores an accepted selection after reload before the first use', async () => {
    await boot()
    onTestFailed(() => page === undefined ? undefined : saveFailureShot(page, 'web-e2e-model-selection-reload'))
    const { first: firstRow } = await openSeededRows()
    await firstRow.click()
    await selectModel('Acme Large')

    const warningStart = tripwire!.warnings.length
    await page!.reload({ waitUntil: 'load' })
    scaffoldApi!.acknowledgeReloadConnectionLoss(tripwire!, warningStart)
    await page!.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const reloadedRows = await openSeededRows()
    await reloadedRows.first.click()
    await expect.poll(
      () => page!.getByRole('button', { name: 'Select model, current Acme Large' }).count(),
      { timeout: 15_000 },
    ).toBe(1)
    await expect.poll(
      () => page!.getByTestId('model-identity-badge').locator('code').filter({ hasText: 'acme-gateway / acme-large' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    await scaffoldApi!.compareOrRefreshGolden(
      RELOAD_EXPECTED,
      await identitySnapshot(),
      scaffoldApi!.webSnapshotMode(),
    )
    expect(tripwire!.pageErrors).toEqual([])
    expect(tripwire!.warnings).toEqual([])
  }, 90_000)

  it('preserves accepted intent and recovery controls when one provider catalog fails', async () => {
    await boot({ routeOnlyProviders: FAILURE_ROUTES }, undefined, ['model-identities-failure'])
    onTestFailed(() => page === undefined ? undefined : saveFailureShot(page, 'web-e2e-model-selection-provider-failure'))
    const { first: firstRow } = await openSeededRows()
    await firstRow.click()
    await selectModel('Recovery Large')
    await expect.poll(
      () => page!.getByTestId('model-identity-badge').locator('code').filter({ hasText: 'recovery-gateway / recovery-large' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    const accepted = await identitySnapshot()

    const trigger = page!.getByRole('button', { name: 'Select model, current Recovery Large' })
    await trigger.click()
    await page!.getByRole('menuitem', { name: /Model/ }).click()
    const failure = page!.getByText('Unavailable Gateway failed to load: catalog endpoint is unavailable')
    await failure.waitFor({ timeout: 15_000 })
    const retry = page!.getByRole('button', { name: /retry|reload/i }).last()
    await expect.poll(() => retry.isVisible(), { timeout: 15_000 }).toBe(true)
    await expect.poll(
      () => page!.getByRole('menuitemradio', { name: 'Recovery Large', exact: true }).isEnabled(),
      { timeout: 15_000 },
    ).toBe(true)
    await retry.click()
    await failure.waitFor({ timeout: 15_000 })
    await expect.poll(() => retry.isVisible(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 15_000 })
      .toBe('Select model, current Recovery Large')
    const recovered = await identitySnapshot()

    await scaffoldApi!.compareOrRefreshGolden(
      FAILURE_EXPECTED,
      `## Accepted intent while one provider catalog fails\n\n${accepted}\n\n`
        + `## Recovery control after retry\n\n${recovered}`,
      scaffoldApi!.webSnapshotMode(),
    )
    expect(tripwire!.pageErrors).toEqual([])
    expect(tripwire!.warnings).toEqual([])
  }, 90_000)

  it('labels a running-turn change as Next turn until the next request uses it', async () => {
    sidecarDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-model-identities-'))
    const marker = join(sidecarDir, 'first-call-hung')
    const overridePath = join(sidecarDir, 'replay.override.json')
    await writeFile(overridePath, JSON.stringify({
      patches: [{ at: 0, entry: { kind: 'hang', readyFile: marker } }],
    }))
    await boot({
      replayFixture: SEED,
      replayOverride: overridePath,
      replayProviders: RUNNING_REPLAY_PROVIDERS,
    }, undefined, ['model-identities-running'])
    onTestFailed(() => page === undefined ? undefined : saveFailureShot(page, 'web-e2e-model-selection-running-turn'))
    const { first: firstRow } = await openSeededRows()
    await firstRow.click()

    const input = page!.locator('textarea').first()
    await input.waitFor({ timeout: 15_000 })
    const settled = scaffold!.whenTurnSettled()
    await input.fill('Start a deterministic running turn and wait.')
    await input.press('Enter')
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true)
    await expect.poll(
      () => page!.getByRole('button', { name: 'Stop generating' }).isVisible(),
      { timeout: 15_000 },
    ).toBe(true)

    await selectModel('Acme Large')
    await expect.poll(
      () => page!.getByTestId('model-identity-badge').locator('code').filter({ hasText: 'acme-gateway / acme-large' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    const runningSnapshot = await identitySnapshot()
    expect(runningSnapshot).toContain('- text: Next turn')
    expect(runningSnapshot).toContain('- code: deepseek-official / deepseek-v4-flash')

    await page!.getByRole('button', { name: 'Stop generating' }).click()
    await settled
    await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)

    const nextSettled = scaffold!.whenTurnSettled()
    await input.fill('Use the accepted model on the next request.')
    await input.press('Enter')
    await nextSettled
    await expect.poll(
      () => page!.getByTestId('model-identity-badge').locator('code').filter({ hasText: 'acme-gateway / acme-large' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    const nextRequestSnapshot = await identitySnapshot()
    expect(nextRequestSnapshot).not.toContain('- text: Next turn')
    expect(nextRequestSnapshot).toContain('- text: Effective')
    expect(nextRequestSnapshot).toContain('- code: acme-gateway / acme-large')

    await scaffoldApi!.compareOrRefreshGolden(
      RUNNING_EXPECTED,
      `## Running turn after changing the selection\n\n${runningSnapshot}\n\n`
        + `## After the next request\n\n${nextRequestSnapshot}`,
      scaffoldApi!.webSnapshotMode(),
    )
    expect(tripwire!.pageErrors).toEqual([])
    expect(tripwire!.warnings).toEqual([])
  }, 120_000)
})
