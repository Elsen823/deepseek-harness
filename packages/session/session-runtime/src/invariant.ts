/** Package-owned Session runtime status invariants. @module @deepseek-ai/dsh-session-runtime/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionRuntimeStatus } from './types.ts'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-runtime'

/** Cordis companion plugin name. */
export const name = 'session-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one committed whole status and its preceding value. */
function validate(
  ctx: Context,
  status: SessionRuntimeStatus,
  previous: SessionRuntimeStatus | undefined,
  fail: InvariantFailure,
): void {
  if (ctx.sessionRuntimes.get(status.sessionId) !== status) {
    fail(`status event for "${status.sessionId}" is not the registry's current exact value`)
  }
  if (!Number.isSafeInteger(status.revision) || status.revision < 1) {
    fail(`status for "${status.sessionId}" carries invalid revision ${String(status.revision)}`)
  }
  if (previous === undefined) {
    if (status.revision !== 1) fail(`first status for "${status.sessionId}" must have revision 1`)
  } else if (previous.sessionId !== status.sessionId
    || previous.driverId !== status.driverId
    || status.revision !== previous.revision + 1) {
    fail(`status for "${status.sessionId}" does not advance one immutable Driver revision`)
  }
  const available = status.availability.kind === 'available'
  if (available !== (status.activity !== undefined)) {
    fail(`status for "${status.sessionId}" must carry activity exactly while available`)
  }
  if (!Number.isSafeInteger(status.attention.approvals) || status.attention.approvals < 0
    || !Number.isSafeInteger(status.attention.userInputs) || status.attention.userInputs < 0) {
    fail(`status for "${status.sessionId}" carries invalid attention counts`)
  }
  if (typeof status.operation !== 'string' || status.operation.length === 0) {
    fail(`status for "${status.sessionId}" carries an empty operation`)
  }
  if (status.detail !== undefined
    && (typeof status.detail.kind !== 'string' || status.detail.kind.length === 0 || !isJsonValue(status.detail.data))) {
    fail(`status for "${status.sessionId}" carries invalid Driver detail`)
  }
}

/** Install validation for every committed process-local runtime value. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('session-runtime/status', ({ status, previous }) => {
    validate(ctx, status, previous, fail)
  }, { global: true })
}, { inject: ['sessionRuntimes'] })

/**
 * Register the Session runtime invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
