// Real Chromium proof for the opt-in Claude Agent Driver Web overlay. The
// provider and browser settings entry are loaded through the same scaffold
// composition a deployment patch would use; the replay fixture supplies a
// deterministic Claude-bound Session without issuing a native model call.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-session-runtime'
import { AgentDriverId, SessionId } from '@deepseek-ai/dsh-session'
import { observeClaudeSession } from '@deepseek-ai/dsh-claude-agent-driver'
import {
  assertFixtureInventory, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/claude-agent-driver', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const OVERLAY = join(process.cwd(), 'apps/web/tests/claude-agent-driver.overlay.yml')
const SESSION_ID = 'claude-agent-driver-web-e2e'
const REAL_PROMPT = 'Reply with exactly CLAUDE_REAL_BROWSER_RESPONSE and do not use tools.'
const REAL_RESPONSE = 'CLAUDE_REAL_BROWSER_RESPONSE'
const REAL_RESUME_PROMPT = 'Reply with exactly CLAUDE_REAL_BROWSER_RESUME_RESPONSE and do not use tools.'
const REAL_RESUME_RESPONSE = 'CLAUDE_REAL_BROWSER_RESUME_RESPONSE'

interface SessionHistoryRow {
  readonly event: {
    readonly type: string
    readonly data?: Record<string, unknown> & {
      readonly driver?: { readonly payload?: Record<string, unknown> }
    }
  }
}

interface SessionListRow {
  readonly sessionId: string
  readonly driverId: string
  readonly runtime?: {
    readonly availability: { readonly kind: string }
    readonly activity?: string
    readonly attention: { readonly approvals: number; readonly userInputs: number }
  }
}

async function sessionHistory(baseUrl: string, sessionId = SESSION_ID): Promise<SessionHistoryRow[]> {
  const response = await fetch(`${baseUrl}/api/session.history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'claude-agent-driver-history',
      method: 'session.history',
      payload: { sessionId },
    }),
  })
  const body = await response.json() as {
    result: { ok: boolean; value?: { events: SessionHistoryRow[] } }
  }
  if (!response.ok || !body.result.ok || body.result.value === undefined) {
    throw new Error(`Claude browser history request failed: ${response.status}`)
  }
  return body.result.value.events
}

async function sessionList(baseUrl: string, sessionId = SESSION_ID): Promise<SessionListRow | undefined> {
  const response = await fetch(`${baseUrl}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'claude-agent-driver-list',
      method: 'session.list',
      payload: {},
    }),
  })
  const body = await response.json() as {
    result: { value?: { items: SessionListRow[] } }
  }
  return body.result.value?.items.find(item => item.sessionId === sessionId)
}

describe('web e2e: Claude Agent Driver overlay', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      requiresDeepSeekCredential: false,
    })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the native-ownership management section from the real overlay', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-claude-agent-driver'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Claude Code', exact: true }).click()

    const section = settings.getByRole('heading', { name: 'Claude Code Agent Driver', exact: true })
    await section.waitFor({ timeout: 10_000 })
    const root = section.locator('..')
    expect(await root.getAttribute('data-agent-driver')).toBe('claude')
    expect(await root.getAttribute('aria-label')).toBe('Claude Code Agent Driver')
    const sectionText = await root.textContent()
    expect(sectionText).toContain('Available for new Sessions')
    expect(sectionText).toContain('Instructions, skills, tools, hooks, approvals, and execution remain owned by Claude Code.')
    expect(sectionText).toContain('Grok remains a reserved blank adapter.')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('opens a Claude-bound Session and exposes native identity, activity, status, observation, and resume evidence', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-claude-agent-driver-session'))
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    if (await settingsDialog.count() > 0) {
      await page.keyboard.press('Escape')
      await settingsDialog.waitFor({ state: 'detached', timeout: 10_000 })
    }
    const sessionsTree = page.getByRole('tree', { name: 'Sessions', exact: true })
    const groupRow = sessionsTree.locator('[role="treeitem"]').filter({ hasText: 'Ungrouped' }).first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const workspaceRow = sessionsTree.locator('[role="treeitem"]')
      .filter({ hasText: basename(scaffold.workspaceCwd) }).first()
    await workspaceRow.waitFor({ timeout: 15_000 })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    const sessionRow = sessionsTree.locator('[role="treeitem"]')
      .filter({ hasText: 'Claude Agent Driver browser proof' }).first()
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()

    await page.getByText('CLAUDE_BROWSER_RESPONSE', { exact: true }).waitFor({ timeout: 15_000 })
    const badge = page.getByTestId('model-identity-badge')
    await badge.waitFor({ timeout: 15_000 })
    const identity = await badge.textContent()
    expect(identity).toContain('DSH Session')
    expect(identity).toContain(SESSION_ID)
    expect(identity).toContain('Selected')
    expect(identity).toContain('anthropic / sonnet')
    expect(identity).toContain('Effective')
    expect(identity).toContain('Native')
    expect(identity).toContain('claude-sonnet-4-6 · high')
    expect(identity).toContain('claude-native-thread-08')
    expect(identity).not.toContain('Unknown')

    const history = await sessionHistory(scaffold.baseUrl)
    const activations = history.filter(row => row.event.type === 'agent-driver/activation')
    expect(activations[0]?.event.data?.provenance).toBeUndefined()
    const requests = history.filter(row => row.event.type === 'agent-driver/model-request')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.event.data?.driver?.payload).toMatchObject({
      nativeModel: 'claude-sonnet-4-6',
      nativeEffort: 'high',
      nativeSelection: { model: 'claude-sonnet-4-6', effort: 'high' },
      nativeOptions: { model: 'claude-sonnet-4-6', sessionId: 'claude-native-thread-08' },
    })
    expect(requests[0]?.event.data?.driver?.payload).not.toHaveProperty('threadId')
    const firstCheckpoint = history.find(row => (
      row.event.type === 'agent-driver/checkpoint' && row.event.data?.phase === 'captured'
    ))
    expect(firstCheckpoint?.event.data?.provenance).toMatchObject({
      kind: 'created', nativeConversationId: 'claude-native-thread-08',
    })
    expect(requests[1]?.event.data?.driver?.payload).toMatchObject({
      threadId: 'claude-native-thread-08',
      nativeOptions: { resume: 'claude-native-thread-08' },
    })

    const agent = scaffold.ctx.agents.get(SessionId(SESSION_ID))
    if (agent === undefined) throw new Error('Claude browser fixture did not attach a live Agent')
    expect(agent.session.header.driverId).toBe('claude')
    expect(agent.status).toBe('idle')
    const beforeObservation = agent.session.events.length
    const observation = observeClaudeSession(agent.session)
    expect(agent.session.events.length).toBe(beforeObservation)
    expect(observation).toMatchObject({
      sessionId: SESSION_ID,
      driverId: 'claude',
      nativeConversationId: 'claude-native-thread-08',
      activities: 1,
      status: 'active',
    })

    const activityTab = page.getByRole('tab', { name: 'Driver Activity', exact: true })
    await activityTab.click()
    const activitySurface = page.getByRole('region', { name: 'Driver Activity', exact: true })
    await activitySurface.waitFor({ timeout: 10_000 })
    const activityText = await activitySurface.textContent()
    expect(activityText).toContain('Read-only native input, output, and activity. Send messages from Chat.')
    expect(activityText).toContain(SESSION_ID)
    expect(activityText).toContain('claude-native-thread-08')
    expect(activityText).toContain('Claude native Bash')
    expect(activityText).toContain('completed')
    expect(await activitySurface.getByRole('textbox').count()).toBe(0)
    expect(await sessionHistory(scaffold.baseUrl)).toHaveLength(history.length)

    const activity = history.find(event => event.event.type === 'agent-driver/activity')
    expect(activity?.event.data).toMatchObject({
      owner: 'claude',
      title: 'Claude native Bash',
    })
    const resumed = history.find(event => (
      event.event.type === 'agent-driver/activation'
      && event.event.data?.phase === 'active'
      && (event.event.data.provenance as { kind?: string } | undefined)?.kind === 'resumed'
    ))
    expect(resumed?.event.data?.provenance).toMatchObject({
      kind: 'resumed',
      nativeConversationId: 'claude-native-thread-08',
    })
    const listed = await sessionList(scaffold.baseUrl)
    expect(listed).toMatchObject({
      sessionId: SESSION_ID,
      driverId: 'claude',
      runtime: {
        availability: { kind: 'available' },
        activity: 'idle',
        attention: { approvals: 0, userInputs: 0 },
      },
    })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the browser demo fixture keyless and call-free', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'settings.expected.txt'])
  })
})

const REAL_FLOW_ENABLED = process.env.DSH_CLAUDE_REAL_FLOW === '1'
  && process.env.DSH_SNAPSHOT === 'record'

describe.skipIf(!REAL_FLOW_ENABLED)('web e2e: Claude Agent Driver native flow', () => {
  const realSessionId = SessionId('claude-agent-driver-real-flow')
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let agent: NonNullable<ReturnType<WebScaffold['ctx']['agents']['get']>>
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      requiresDeepSeekCredential: false,
      routeOnlyProviders: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      }, {
        id: 'anthropic',
        name: 'Anthropic',
        models: [{ id: 'sonnet', name: 'sonnet' }],
      }],
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('real Claude flow workspace was not registered')
    const created = await scaffold.ctx.apiProxy.sessions.create({
      rpcId: `claude-real-create-${String(realSessionId)}` as never,
      payload: {
        sessionId: realSessionId,
        workspaceId: workspace.id,
        driverId: AgentDriverId('claude'),
      },
    })
    if (!created.result.ok) throw new Error(`real Claude session creation failed: ${created.result.error.message}`)
    const createdAgent = scaffold.ctx.agents.get(realSessionId)
    if (createdAgent === undefined) throw new Error('real Claude session did not publish a live Agent')
    agent = createdAgent
    await agent.modelSelection.accept({ provider: 'anthropic', model: 'sonnet' })
    agent.session.append('session/title', {
      title: 'Claude Agent Driver real browser flow',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    await scaffold.ctx.sessions.flush(agent.session)
    if (await sessionList(scaffold.baseUrl, realSessionId) === undefined) {
      throw new Error('real Claude session did not enter the normal session.list projection')
    }
    // A blank Session is intentionally hidden from every account except the
    // current provisional New Session row. Persist the selection through the
    // client’s normal restore cell so reload renders this host-created row.
    await page.evaluate((sessionId) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, String(realSessionId))
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('records a real native turn and renders its Session and conversation identities', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-claude-agent-driver-real-flow'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const sessionsTree = page.getByRole('tree', { name: 'Sessions', exact: true })
    const workspaceRow = sessionsTree.locator('[role="treeitem"]')
      .filter({ hasText: basename(join(scaffold.workspaceCwd, 'workspace')) }).first()
    await workspaceRow.waitFor({ timeout: 15_000 })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    const sessionRow = page.getByRole('treeitem', { name: 'New Session', exact: true })
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
    const input = page.locator('textarea:enabled').first()
    await input.waitFor({ timeout: 15_000 })
    await input.fill(REAL_PROMPT)
    await input.press('Enter')
    await page.getByText(REAL_RESPONSE, { exact: true }).waitFor({ timeout: 60_000 })
    await agent.whenIdle()
    await scaffold.ctx.sessions.flush(agent.session)

    const firstEvents = agent.session.events
    const firstRequests = firstEvents.filter(event => event.type === 'agent-driver/model-request')
    expect(firstRequests).toHaveLength(1)
    const firstRequest = firstRequests[0]
    if (firstRequest?.type !== 'agent-driver/model-request') throw new Error('real Claude request was not recorded')
    expect(firstRequest.data.config).toMatchObject({ provider: 'anthropic', model: 'sonnet' })
    expect(firstRequest.data.messages).toHaveLength(1)
    expect(firstRequest.data.messages[0]?.content).toEqual([{ type: 'text', text: REAL_PROMPT }])
    expect(firstRequest.data.driver?.payload).toMatchObject({
      prompt: REAL_PROMPT,
      nativeModel: 'sonnet',
      nativeEffort: null,
      nativeSelection: { model: 'sonnet' },
      nativeInputsNotExposedBySdk: ['instructions', 'skills', 'tools', 'hooks'],
    })
    const firstPayload = firstRequest.data.driver?.payload
    if (firstPayload === undefined || typeof firstPayload !== 'object' || firstPayload === null || Array.isArray(firstPayload)) {
      throw new Error('real Claude request did not record an object driver payload')
    }
    const firstNativeOptions = firstPayload.nativeOptions
    if (firstNativeOptions === undefined || typeof firstNativeOptions !== 'object' || firstNativeOptions === null || Array.isArray(firstNativeOptions)) {
      throw new Error('real Claude request did not record object native options')
    }
    expect(firstNativeOptions).toMatchObject({
      model: 'sonnet',
      permissionMode: 'dontAsk',
      includePartialMessages: true,
    })
    expect(firstNativeOptions).not.toHaveProperty('resume')
    expect(firstEvents.some(event => event.type === 'agent-driver/model-attempt'
      && event.data.outcome === 'succeeded')).toBe(true)
    expect(firstEvents.some(event => event.type === 'agent-driver/activity')).toBe(true)
    expect(firstEvents.some(event => event.type === 'agent-driver/checkpoint'
      && event.data.phase === 'captured')).toBe(true)
    const firstAssistant = firstEvents.find(event => event.type === 'assistant/message')
    if (firstAssistant?.type !== 'assistant/message') throw new Error('real Claude assistant message was not recorded')
    expect(firstAssistant.data.message.content).toEqual([{ type: 'text', text: REAL_RESPONSE }])

    const firstObservation = observeClaudeSession(agent.session)
    const nativeConversationId = firstObservation.nativeConversationId
    expect(nativeConversationId).toBeTruthy()
    expect(firstObservation.activities).toBeGreaterThan(0)
    expect(firstObservation.status).toBe('active')
    expect(agent.status).toBe('idle')
    expect(agent.session.modelSelection()).toMatchObject({ provider: 'anthropic', model: 'sonnet' })
    expect(agent.session.effectiveModelSelection()).toMatchObject({ provider: 'anthropic', model: 'sonnet' })
    const beforeObservation = agent.session.events.length
    expect(observeClaudeSession(agent.session)).toEqual(firstObservation)
    expect(agent.session.events.length).toBe(beforeObservation)

    const runtime = scaffold.ctx.sessionRuntimes.get(realSessionId)
    expect(runtime).toMatchObject({
      sessionId: realSessionId,
      driverId: 'claude',
      availability: { kind: 'available' },
      activity: 'idle',
      attention: { approvals: 0, userInputs: 0 },
    })
    const firstHistory = await sessionHistory(scaffold.baseUrl, realSessionId)
    expect(firstHistory.some(row => row.event.type === 'agent-driver/model-request')).toBe(true)
    expect(firstHistory.some(row => row.event.type === 'agent-driver/checkpoint')).toBe(true)
    const firstCheckpoint = firstHistory.find(row => row.event.type === 'agent-driver/checkpoint')
    expect(firstCheckpoint?.event.data?.provenance).toMatchObject({
      nativeConversationId: String(nativeConversationId),
    })

    const badge = page.getByTestId('model-identity-badge')
    await badge.waitFor({ timeout: 15_000 })
    const identity = await badge.textContent()
    expect(identity).toContain(String(realSessionId))
    expect(identity).toContain('Selected')
    expect(identity).toContain('anthropic / sonnet')
    expect(identity).toContain('Effective')
    expect(identity).toContain('Native')
    expect(identity).toContain('sonnet')
    expect(identity).toContain(String(nativeConversationId))
    expect(identity).not.toContain('Unknown')

    const activityTab = page.getByRole('tab', { name: 'Driver Activity', exact: true })
    await activityTab.click()
    const activitySurface = page.getByRole('region', { name: 'Driver Activity', exact: true })
    await activitySurface.waitFor({ timeout: 10_000 })
    const activityText = await activitySurface.textContent()
    expect(activityText).toContain('Read-only native input, output, and activity. Send messages from Chat.')
    expect(activityText).toContain(String(realSessionId))
    expect(activityText).toContain(String(nativeConversationId))
    expect(activityText).toContain('idle')
    expect(await activitySurface.getByRole('textbox').count()).toBe(0)

    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await input.waitFor({ timeout: 15_000 })
    await input.fill(REAL_RESUME_PROMPT)
    await input.press('Enter')
    await page.getByText(REAL_RESUME_RESPONSE, { exact: true }).waitFor({ timeout: 60_000 })
    await agent.whenIdle()
    await scaffold.ctx.sessions.flush(agent.session)

    const events = agent.session.events
    const requests = events.filter(event => event.type === 'agent-driver/model-request')
    expect(requests).toHaveLength(2)
    const resumedRequest = requests[1]
    if (resumedRequest?.type !== 'agent-driver/model-request') throw new Error('real Claude resume request was not recorded')
    expect(resumedRequest.data.driver?.payload).toMatchObject({
      prompt: REAL_RESUME_PROMPT,
      threadId: nativeConversationId,
      nativeOptions: { model: 'sonnet', resume: nativeConversationId },
    })
    expect(resumedRequest.data.messages).toHaveLength(1)
    expect(resumedRequest.data.messages[0]?.content).toEqual([{ type: 'text', text: REAL_RESUME_PROMPT }])
    const assistants = events.filter(event => event.type === 'assistant/message')
    expect(assistants).toHaveLength(2)
    const resumedAssistant = assistants[1]
    if (resumedAssistant?.type !== 'assistant/message') throw new Error('real Claude resumed assistant message was not recorded')
    expect(resumedAssistant.data.message.content).toEqual([{ type: 'text', text: REAL_RESUME_RESPONSE }])
    const resumedObservation = observeClaudeSession(agent.session)
    expect(resumedObservation).toMatchObject({
      nativeConversationId,
      status: 'active',
    })
    expect(resumedObservation.activities).toBeGreaterThan(0)
    expect(agent.status).toBe('idle')
    expect((await sessionList(scaffold.baseUrl, realSessionId))?.runtime).toMatchObject({
      availability: { kind: 'available' },
      activity: 'idle',
      attention: { approvals: 0, userInputs: 0 },
    })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
