/** Pure presentation projection for age-filtered subagent catalogs. */

import {
  indexSubagentDescendants,
  type SessionId,
  type SessionListState,
  type SessionSummary,
  type SubagentCatalogSnapshot,
  type SubagentDescendantSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SubagentVisibilitySettings } from '../catalog-settings-contract.ts'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-subagent/client'

type Catalogs = SessionListState['subagentsByParent']
type Summaries = Readonly<Record<SessionId, SessionSummary>>
type CatalogEntry = SubagentCatalogSnapshot['entries'][number]

/** Inputs for one coherent catalog presentation cut. */
export interface SubagentCatalogVisibilityInput {
  readonly catalogs: Catalogs
  readonly summaries: Summaries
  readonly now: number
  readonly settings: SubagentVisibilitySettings
}

/** Filtered presentation values; the retained runtime catalogs remain untouched. */
export interface SubagentCatalogVisibilityResult {
  readonly catalogs: Catalogs
  readonly summaries: Summaries
  readonly descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>
  /** Next wall-clock instant when one visible inactive row reaches the threshold. */
  readonly nextExpirationAt?: number
}

function lastActivityAt(summary: SessionSummary): number | undefined {
  const exact = summary.projectionValues?.subagentTiming?.lastActivityAt
  if (exact !== undefined && exact > 0) return exact

  const stats = summary.projectionValues?.sessionStats
  if (summary.updatedAt <= 0 || stats === undefined) return undefined
  return summary.updatedAt + stats.llmMs + stats.toolMs
}

function addAncestors(
  visible: Set<SessionId>,
  catalogs: Catalogs,
  summaries: Summaries,
): void {
  const catalogParents = new Map<SessionId, Set<SessionId>>()
  for (const [parentIdValue, catalog] of Object.entries(catalogs)) {
    const parentId = parentIdValue as SessionId
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child') continue
      const parents = catalogParents.get(entry.id) ?? new Set<SessionId>()
      parents.add(parentId)
      catalogParents.set(entry.id, parents)
    }
  }

  const pending = [...visible]
  const visited = new Set<SessionId>()
  while (pending.length > 0) {
    const id = pending.pop() as SessionId
    if (visited.has(id)) continue
    visited.add(id)
    const summary = summaries[id]
    const parents = [
      ...(summary?.origin === 'subagent' && summary.parentId !== undefined
        ? [summary.parentId]
        : []),
      ...(catalogParents.get(id) ?? []),
    ]
    for (const parentId of parents) {
      if (visible.has(parentId)) continue
      visible.add(parentId)
      pending.push(parentId)
    }
  }
}

function catalogChildVisible(
  id: SessionId,
  summaries: Summaries,
  visible: ReadonlySet<SessionId>,
): boolean {
  return summaries[id]?.origin !== 'subagent' || visible.has(id)
}

function projectCatalog(
  catalog: SubagentCatalogSnapshot,
  catalogs: Catalogs,
  summaries: Summaries,
  visible: ReadonlySet<SessionId>,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
): SubagentCatalogSnapshot {
  let changed = false
  const entries: CatalogEntry[] = []
  for (const entry of catalog.entries) {
    if (entry.kind === 'diagnostic') {
      entries.push(entry)
      continue
    }
    const summary = summaries[entry.id]
    if (summary?.origin === 'subagent' && !visible.has(entry.id)) {
      changed = true
      continue
    }
    if (summary === undefined) {
      entries.push(entry)
      continue
    }
    const childCatalog = catalogs[entry.id]
    const catalogMayHaveVisibleChildren = childCatalog === undefined
      ? entry.hasChildren
      : childCatalog.state !== 'ready' || childCatalog.entries.some(childEntry => (
        childEntry.kind === 'diagnostic'
        || catalogChildVisible(childEntry.id, summaries, visible)
      ))
    const hasChildren = (descendants.get(entry.id)?.count ?? 0) > 0
      || catalogMayHaveVisibleChildren
    if (hasChildren === entry.hasChildren) entries.push(entry)
    else {
      changed = true
      entries.push({ ...entry, hasChildren })
    }
  }
  return changed ? { ...catalog, entries } : catalog
}

/**
 * Hide only non-running rows with a durable activity timestamp at or beyond the
 * configured age. Missing timing fails open, and stale ancestors remain when a
 * visible descendant needs them for navigation.
 *
 * @param input - Retained catalogs, summaries, time, and durable preference.
 * @returns One consistent projection for counts, loading rows, and tree rows.
 */
export function projectSubagentCatalogVisibility(
  input: SubagentCatalogVisibilityInput,
): SubagentCatalogVisibilityResult {
  const { catalogs, summaries, now, settings } = input
  if (!settings.hideInactive) {
    return { catalogs, summaries, descendants: indexSubagentDescendants(summaries) }
  }

  const thresholdMs = settings.inactiveAfterMinutes * 60_000
  const visible = new Set<SessionId>()
  const catalogRunning = new Set<SessionId>()
  let nextExpirationAt: number | undefined
  for (const summary of Object.values(summaries)) {
    if (summary.origin !== 'subagent') continue
    const activityAt = lastActivityAt(summary)
    if (summary.running || activityAt === undefined) {
      visible.add(summary.id)
      continue
    }
    const expiresAt = activityAt + thresholdMs
    if (now < expiresAt) {
      visible.add(summary.id)
      nextExpirationAt = nextExpirationAt === undefined
        ? expiresAt
        : Math.min(nextExpirationAt, expiresAt)
    }
  }

  for (const [parentIdValue, catalog] of Object.entries(catalogs)) {
    const parentId = parentIdValue as SessionId
    if (catalog.state !== 'ready' || catalog.entries.some(entry => entry.kind === 'diagnostic')) {
      visible.add(parentId)
    }
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child') continue
      if (entry.activity === 'running') {
        visible.add(entry.id)
        catalogRunning.add(entry.id)
      } else if (summaries[entry.id]?.origin !== 'subagent') visible.add(entry.id)
      if (entry.hasChildren && catalogs[entry.id] === undefined) visible.add(entry.id)
    }
  }
  addAncestors(visible, catalogs, summaries)

  const visibleSummaries = {} as Record<SessionId, SessionSummary>
  for (const summary of Object.values(summaries)) {
    if (summary.origin === 'subagent' && !visible.has(summary.id)) continue
    visibleSummaries[summary.id] = catalogRunning.has(summary.id) && !summary.running
      ? { ...summary, running: true }
      : summary
  }
  const descendants = indexSubagentDescendants(visibleSummaries)
  const visibleCatalogs = Object.fromEntries(Object.entries(catalogs).map(([id, catalog]) => (
    [id, projectCatalog(catalog, catalogs, summaries, visible, descendants)]
  ))) as Record<SessionId, SubagentCatalogSnapshot>

  return {
    catalogs: visibleCatalogs,
    summaries: visibleSummaries,
    descendants,
    ...(nextExpirationAt === undefined ? {} : { nextExpirationAt }),
  }
}
