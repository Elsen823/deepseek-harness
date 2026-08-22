import { describe, expect, it } from 'vitest'
import type {
  SessionId, SessionListState, SessionSummary, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SubagentVisibilitySettings } from '../src/catalog-settings-contract.ts'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import { projectSubagentCatalogVisibility } from '../src/client/catalog-visibility.ts'

const ROOT = 'root' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId
const HOUR = 60 * 60 * 1_000
const NOW = 10 * HOUR
const SETTINGS: SubagentVisibilitySettings = {
  hideInactive: true,
  inactiveAfterMinutes: 60,
}

function summary(
  id: SessionId,
  parentId: SessionId,
  options: {
    running?: boolean
    lastActivityAt?: number
    updatedAt?: number
    legacyActiveMs?: number
  } = {},
): SessionSummary {
  const timing = options.lastActivityAt === undefined
    ? undefined
    : { settledMs: 0, lastActivityAt: options.lastActivityAt }
  const sessionStats = options.legacyActiveMs === undefined
    ? undefined
    : {
      turns: 1,
      steps: 1,
      llmMs: options.legacyActiveMs,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
    }
  return {
    id,
    parentId,
    origin: 'subagent',
    displayTitle: id,
    running: options.running ?? false,
    blank: false,
    updatedAt: options.updatedAt ?? options.lastActivityAt ?? NOW,
    ...(timing === undefined && sessionStats === undefined
      ? {}
      : {
        projectionValues: {
          ...(timing === undefined ? {} : { subagentTiming: timing }),
          ...(sessionStats === undefined ? {} : { sessionStats }),
        },
      }),
  }
}

function catalog(
  parentId: SessionId,
  entries: SubagentCatalogSnapshot['entries'],
): [SessionId, SubagentCatalogSnapshot] {
  return [parentId, {
    entries,
    parentAvailable: true,
    state: 'ready',
    error: null,
  }]
}

function child(
  id: SessionId,
  activity: 'running' | 'inactive' = 'inactive',
  hasChildren = false,
): SubagentCatalogSnapshot['entries'][number] {
  return { kind: 'child', id, mode: 'continuable', label: id, activity, hasChildren }
}

function project(
  catalogs: SessionListState['subagentsByParent'],
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  settings = SETTINGS,
) {
  return projectSubagentCatalogVisibility({ catalogs, summaries, now: NOW, settings })
}

describe('projectSubagentCatalogVisibility', () => {
  it('hides an inactive row at the exact threshold and reports no descendants', () => {
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD)])]),
      { [CHILD]: summary(CHILD, ROOT, { lastActivityAt: NOW - HOUR }) },
    )

    expect(result.catalogs[ROOT]?.entries).toEqual([])
    expect(result.descendants.get(ROOT)).toBeUndefined()
  })

  it('keeps inactive rows before the threshold and schedules their expiration', () => {
    const expiresAt = NOW + 1
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD)])]),
      { [CHILD]: summary(CHILD, ROOT, { lastActivityAt: expiresAt - HOUR }) },
    )

    expect(result.catalogs[ROOT]?.entries).toHaveLength(1)
    expect(result.descendants.get(ROOT)).toEqual({ count: 1, runningCount: 0 })
    expect(result.nextExpirationAt).toBe(expiresAt)
  })

  it('uses durable prompt recency plus cumulative execution for legacy rows', () => {
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD)])]),
      {
        [CHILD]: summary(CHILD, ROOT, {
          updatedAt: NOW - 2 * HOUR,
          legacyActiveMs: 30 * 60 * 1_000,
        }),
      },
    )

    expect(result.catalogs[ROOT]?.entries).toEqual([])
    expect(result.descendants.get(ROOT)).toBeUndefined()
  })

  it('keeps a recent legacy row until its estimated activity expires', () => {
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD)])]),
      {
        [CHILD]: summary(CHILD, ROOT, {
          updatedAt: NOW - 45 * 60 * 1_000,
          legacyActiveMs: 5 * 60 * 1_000,
        }),
      },
    )

    expect(result.catalogs[ROOT]?.entries).toEqual([child(CHILD)])
    expect(result.nextExpirationAt).toBe(NOW + 20 * 60 * 1_000)
  })

  it('always keeps currently running rows regardless of age', () => {
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD, 'running')])]),
      { [CHILD]: summary(CHILD, ROOT, { running: false, lastActivityAt: 0 }) },
    )

    expect(result.catalogs[ROOT]?.entries).toHaveLength(1)
    expect(result.descendants.get(ROOT)).toEqual({ count: 1, runningCount: 1 })
  })

  it('retains an old ancestor needed to reach a recent nested child', () => {
    const catalogs = Object.fromEntries([
      catalog(ROOT, [child(CHILD, 'inactive', true)]),
      catalog(CHILD, [child(GRANDCHILD)]),
    ]) as SessionListState['subagentsByParent']
    const result = project(catalogs, {
      [CHILD]: summary(CHILD, ROOT, { lastActivityAt: NOW - 2 * HOUR }),
      [GRANDCHILD]: summary(GRANDCHILD, CHILD, { lastActivityAt: NOW - 1_000 }),
    })

    expect(result.catalogs[ROOT]?.entries).toEqual([child(CHILD, 'inactive', true)])
    expect(result.catalogs[CHILD]?.entries).toEqual([child(GRANDCHILD)])
    expect(result.descendants.get(ROOT)).toEqual({ count: 2, runningCount: 0 })
  })

  it('fails open for missing timing and preserves diagnostics', () => {
    const diagnostic = { kind: 'diagnostic', id: 'bad' as SessionId, reason: 'corrupt' } as const
    const result = project(
      Object.fromEntries([catalog(ROOT, [child(CHILD), diagnostic])]),
      { [CHILD]: summary(CHILD, ROOT) },
    )

    expect(result.catalogs[ROOT]?.entries).toEqual([child(CHILD), diagnostic])
  })

  it('keeps disclosure and nested rows when a child summary has not arrived', () => {
    const unknown = 'unknown' as SessionId
    const catalogs = Object.fromEntries([
      catalog(ROOT, [child(CHILD, 'inactive', true)]),
      catalog(CHILD, [child(unknown)]),
    ]) as SessionListState['subagentsByParent']
    const result = project(catalogs, {
      [CHILD]: summary(CHILD, ROOT, { lastActivityAt: NOW - 1_000 }),
    })

    expect(result.catalogs[ROOT]?.entries).toEqual([child(CHILD, 'inactive', true)])
    expect(result.catalogs[CHILD]?.entries).toEqual([child(unknown)])
  })

  it('returns the complete presentation when the setting is disabled', () => {
    const catalogs = Object.fromEntries([catalog(ROOT, [child(CHILD)])]) as SessionListState['subagentsByParent']
    const result = project(catalogs, {
      [CHILD]: summary(CHILD, ROOT, { lastActivityAt: 0 }),
    }, { ...SETTINGS, hideInactive: false })

    expect(result.catalogs).toBe(catalogs)
    expect(result.catalogs[ROOT]?.entries).toHaveLength(1)
  })
})
