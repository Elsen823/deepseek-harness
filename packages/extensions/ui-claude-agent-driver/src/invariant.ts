/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-claude-agent-driver`.
 * @module @deepseek-ai/dsh-client-ui-claude-agent-driver/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-claude-agent-driver'

/** Cordis companion plugin name. */
export const name = 'client-ui-claude-agent-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the browser entry only projects a Host Driver catalog
 * into settings slots; its data relation is owned by the Host API and slot core.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
