/** Package invariant companion for the portable Proposed Plan projection. @module @deepseek-ai/dsh-plan-proposal/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plan-proposal'

/** Cordis companion plugin name. */
export const name = 'plan-proposal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each event carries a complete immutable document
 * snapshot, and the projection registry validates its cached and wire values.
 * Lifecycle policy remains owner-specific rather than a common transition graph.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
