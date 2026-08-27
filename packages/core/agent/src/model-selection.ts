/** Agent-owned Session Model Selection lifecycle.
 *
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type {
  ModelSelection as SessionModelSelection,
  ModelSelectionSource as SessionModelSelectionSource,
  Session,
} from '@deepseek-ai/dsh-session'
import type { Agent } from './runtime-types.ts'

/** Why a durable Session Model Selection intent was committed. */
export type ModelSelectionSource = SessionModelSelectionSource

/** Complete provider, model, and optional adapter-owned effort for one Agent. */
export type ModelSelection = SessionModelSelection

/** Accepted intent with its durable source. */
export type SelectedModelSelection = ModelSelection & { readonly source: ModelSelectionSource }

/** Immutable selection captured once for one native or DSH Turn. */
export type TurnModelSelection = ModelSelection

/** Options for one Agent-owned Session Model Selection lifecycle. */
export interface ModelSelectionOwnerOptions {
  /** Live default used only until the Session accepts its first selection. */
  readonly defaultSelection?: () => ModelSelection | undefined
  /** Validate provider/model/effort before intent is accepted or a Turn starts. */
  readonly validate?: (selection: ModelSelection, signal?: AbortSignal) => void | Promise<void>
  /** Validate and resolve adapter/provider defaults once at Turn start. */
  readonly resolve?: (selection: ModelSelection, signal?: AbortSignal) => ModelSelection | Promise<ModelSelection>
}

/**
 * Public Agent-owned Model Selection state and lifecycle.
 *
 * `selected` is durable accepted intent; `effective` is the latest request
 * evidence (or a prepared attempt recorded by the Driver); and
 * `defaultSelection` is an uncommitted inherited value. `beginTurn()` is the
 * only operation that materializes a default and freezes a resolved Turn
 * value. Service tier and all other request/Driver settings are intentionally
 * absent from this interface.
 */
export interface ModelSelectionOwner {
  /** Latest accepted durable intent, including its source. */
  readonly selected: SelectedModelSelection | undefined
  /** Latest effective request evidence, or a prepared attempt reported by a Driver. */
  readonly effective: ModelSelection | undefined
  /** Current uncommitted default for a blank Session. */
  readonly defaultSelection: ModelSelection | undefined
  /** Accept and durably append one user or default intent; this is serialized with Turn-start capture. */
  accept(selection: ModelSelection, source?: ModelSelectionSource, signal?: AbortSignal): Promise<SelectedModelSelection>
  /** Validate a candidate without changing durable state. */
  validate(selection: ModelSelection, signal?: AbortSignal): Promise<void>
  /** Update the uncommitted default; this never appends a Session event. */
  setDefaultSelection(selection: ModelSelection | undefined): void
  /** Replace the default resolver for an entry point whose settings are live. */
  setDefaultSource(source: (() => ModelSelection | undefined) | undefined): void
  /** Return one frozen selection for every request in the next Turn. */
  beginTurn(signal?: AbortSignal): Promise<TurnModelSelection>
  /** Record effective evidence after the Driver prepares an attempt. */
  recordEffective(selection: ModelSelection): void
}

/** Agent view after registry publication has installed the selection owner. */
export type AgentWithModelSelection = Agent & { readonly modelSelection: ModelSelectionOwner }

/**
 * Compare only the three fields owned by Model Selection.
 * @param a - first selection, or undefined.
 * @param b - second selection, or undefined.
 * @returns whether both values contain the same provider, model, and effort.
 */
export function modelSelectionsEqual(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  return a?.provider === b?.provider
    && a?.model === b?.model
    && a?.reasoningEffort === b?.reasoningEffort
}

/** Validate and freeze one Model Selection value at the public lifecycle seam. */
function normalizeSelection(selection: ModelSelection): ModelSelection {
  const value: unknown = selection
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('model selection must be a record')
  }
  const candidate = value as Record<string, unknown>
  const allowed = new Set(['provider', 'model', 'reasoningEffort'])
  if (Object.keys(candidate).some(key => !allowed.has(key))) {
    throw new TypeError('model selection accepts only provider, model, and reasoningEffort')
  }
  if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) {
    throw new TypeError('model selection provider must be a non-empty string')
  }
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new TypeError('model selection model must be a non-empty string')
  }
  if (candidate.reasoningEffort !== undefined
    && (typeof candidate.reasoningEffort !== 'string' || candidate.reasoningEffort.length === 0)) {
    throw new TypeError('model selection reasoningEffort must be a non-empty string')
  }
  return deepFreeze({
    provider: candidate.provider,
    model: candidate.model,
    ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
  } as ModelSelection)
}

/** Remove the intent-only source before handing a value to a Driver. */
function selectionOf(selected: SelectedModelSelection): ModelSelection {
  return {
    provider: selected.provider,
    model: selected.model,
    ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
  }
}

/** Concrete owner implementation; all mutable state is held by this Agent member. */
class SessionModelSelectionOwner implements ModelSelectionOwner {
  private defaultSource: (() => ModelSelection | undefined) | undefined
  private effectiveAttempt: ModelSelection | undefined
  private lifecycleTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly session: Session,
    options: ModelSelectionOwnerOptions,
  ) {
    this.defaultSource = options.defaultSelection
    this.validateCandidate = options.validate
    this.resolveCandidate = options.resolve
  }

  private readonly validateCandidate: ModelSelectionOwnerOptions['validate']
  private readonly resolveCandidate: ModelSelectionOwnerOptions['resolve']

  /** Latest accepted durable intent. */
  get selected(): SelectedModelSelection | undefined {
    return this.session.modelSelection()
  }

  /** Serialize selection acceptance with the Turn-start capture. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation)
    this.lifecycleTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Latest request evidence, or Driver-reported prepared evidence. */
  get effective(): ModelSelection | undefined {
    return this.session.effectiveModelSelection() ?? this.effectiveAttempt
  }

  /** Current uncommitted default. */
  get defaultSelection(): ModelSelection | undefined {
    const value = this.defaultSource?.()
    return value === undefined ? undefined : normalizeSelection(value)
  }

  /** Accept and durably append one intent after validation. */
  async accept(
    selection: ModelSelection,
    source: ModelSelectionSource = 'user',
    signal?: AbortSignal,
  ): Promise<SelectedModelSelection> {
    return this.serialize(async () => {
      const normalized = normalizeSelection(selection)
      await this.validate(normalized, signal)
      return this.commit(normalized, source)
    })
  }

  /** Validate one candidate without modifying this owner or its Session. */
  async validate(selection: ModelSelection, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeSelection(selection)
    signal?.throwIfAborted()
    await this.validateCandidate?.(normalized, signal)
    signal?.throwIfAborted()
  }

  /** Replace the inherited default source without creating a durable event. */
  setDefaultSelection(selection: ModelSelection | undefined): void {
    const normalized = selection === undefined ? undefined : normalizeSelection(selection)
    this.defaultSource = () => normalized
  }

  /** Set a dynamic default source for a legacy entry point. */
  setDefaultSource(source: (() => ModelSelection | undefined) | undefined): void {
    this.defaultSource = source
  }

  /** Append an intent synchronously after the caller has validated it. */
  private commit(selection: ModelSelection, source: ModelSelectionSource): SelectedModelSelection {
    const current = this.selected
    if (current !== undefined && modelSelectionsEqual(current, selection)) return current
    this.session.append('model/selected', { ...selection, source })
    const accepted = this.selected
    if (accepted === undefined) throw new Error('model/selected append did not become the latest Session intent')
    return accepted
  }

  /** Begin one immutable Turn, materializing a default before resolution when needed. */
  async beginTurn(signal?: AbortSignal): Promise<TurnModelSelection> {
    return this.serialize(async () => {
      const accepted = this.selected
      const selected = accepted === undefined ? this.defaultSelection : selectionOf(accepted)
      if (selected === undefined) throw new Error('no default Model Selection is available for this Session')
      // Validate and resolve before materializing an inherited default. An
      // unavailable provider therefore leaves the selected intent unchanged so
      // recovery can repair the route and retry the same prompt.
      const resolved = this.resolveCandidate === undefined
        ? (await this.validate(selected, signal), selected)
        : await this.resolveCandidate(selected, signal)
      signal?.throwIfAborted()
      const turn = normalizeSelection(resolved)
      if (accepted === undefined) {
        // Selection acceptance is serialized with this operation, so this
        // append remains the first accepted prompt's commit point.
        this.commit(selected, 'default')
      }
      return deepFreeze(turn)
    })
  }

  /** Record effective evidence from a prepared native/provider attempt. */
  recordEffective(selection: ModelSelection): void {
    this.effectiveAttempt = normalizeSelection(selection)
  }

}

/**
 * Create one Agent-owned Session model-selection lifecycle.
 * @param session - the exact Session whose log stores accepted intent.
 * @param options - default, validation, and provider-resolution callbacks.
 * @returns a state owner with no process-global identity.
 */
export function createModelSelectionOwner(session: Session, options: ModelSelectionOwnerOptions = {}): ModelSelectionOwner {
  return new SessionModelSelectionOwner(session, options)
}
