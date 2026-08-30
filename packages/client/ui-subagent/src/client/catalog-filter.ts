/** Synchronous extension point for coherent subagent catalog presentation. */

import type {
  SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { indexSubagentDescendants, type SubagentDescendantSummary } from './subagent-lineage.ts'

/** Inputs shared by the catalog count and tree-rendering paths. */
export interface SubagentCatalogFilterInput {
  /** Session whose catalog roots this presentation. */
  readonly rootSessionId: SessionId
  /** Selected descendant, when the presentation is a sibling switcher. */
  readonly currentSessionId?: SessionId
  /** Retained unfiltered catalogs from the Session Controller. */
  readonly catalogs: SessionListState['subagentsByParent']
  /** Retained unfiltered Session summaries. */
  readonly summaries: Readonly<Record<SessionId, SessionSummary>>
  /** Wall-clock sample shared by filtering and duration rendering. */
  readonly now: number
}

/** One coherent catalog projection consumed by counts and tree rows. */
export interface SubagentCatalogFilterResult {
  /** Catalogs to present without mutating the retained controller state. */
  readonly catalogs: SessionListState['subagentsByParent']
  /** Summaries corresponding to the presented catalogs. */
  readonly summaries: Readonly<Record<SessionId, SessionSummary>>
  /** Descendant totals derived from the presented summaries. */
  readonly descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>
  /** Next wall-clock instant when this projection may change without a Host frame. */
  readonly nextExpirationAt?: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Filter one Web subagent catalog presentation synchronously. Listeners
     * call `next()` to compose; the default returns the complete catalog.
     * @param input - retained catalog state and one shared time sample.
     * @param next - delegate to the next filter or the complete-catalog default.
     * @mode waterfall
     */
    'ui-subagent/catalog-filter'(
      input: SubagentCatalogFilterInput,
      next: () => SubagentCatalogFilterResult,
    ): SubagentCatalogFilterResult
  }
}

/**
 * Project the complete retained catalog without filtering.
 * @param input - retained catalog state.
 * @returns identity catalogs and summaries plus their descendant index.
 */
export function completeSubagentCatalog(
  input: SubagentCatalogFilterInput,
): SubagentCatalogFilterResult {
  return {
    catalogs: input.catalogs,
    summaries: input.summaries,
    descendants: indexSubagentDescendants(input.summaries),
  }
}
