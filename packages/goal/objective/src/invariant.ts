/** Package invariant companion for the portable Objective projection. @module @deepseek-ai/dsh-objective/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-objective'

/** Cordis companion plugin name. */
export const name = 'objective-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns a pure whole-snapshot fold. Native
 * Objective payload JSON is enforced by Session, and DSH Goal stream validity
 * remains authoritative in `@deepseek-ai/dsh-goal/invariant`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
