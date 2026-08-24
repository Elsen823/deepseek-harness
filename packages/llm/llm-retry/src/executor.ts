/** Shared executor for a retry policy captured by `LlmRuntime.prepareCall()`. */

import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

/** One scheduled retry under an immutable captured policy. */
export interface CapturedRetryDecision {
  /** Stable serialization of the policy fields that produced the decision. */
  readonly policyKey: string
  /** One-based retry number after the failed attempt. */
  readonly retry: number
  /** Cancellable delay before the next attempt begins. */
  readonly delayMs: number
}

/** Deterministic hooks for retry scheduling tests. */
export interface CapturedRetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  readonly random?: () => number
}

/**
 * Serialize the fields that determine retry eligibility and delay.
 * @param policy - immutable policy captured with the prepared call.
 * @returns stable policy identity used by durable retry facts.
 */
export function capturedRetryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
}

function localDelay(policy: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/**
 * Decide the next retry without reading deployment configuration. Callers pass
 * the retry count recovered from their own durable log or attempt list.
 * @param policy - exact policy captured with the prepared call.
 * @param failure - structured failure returned by the completed attempt.
 * @param previousRetry - greatest retry number already scheduled under this policy.
 * @param internals - deterministic random source for tests.
 * @returns the next retry and delay, or `undefined` when the policy is exhausted or ineligible.
 */
export function nextCapturedRetry(
  policy: ResolvedRetryPolicy,
  failure: LlmFailure,
  previousRetry: number,
  internals: CapturedRetryInternals = {},
): CapturedRetryDecision | undefined {
  if (!Number.isSafeInteger(previousRetry) || previousRetry < 0) {
    throw new TypeError('previousRetry must be a non-negative safe integer')
  }
  if (policy.mode === 'normal') {
    if (!policy.retryableCodes.includes(failure.code)) return undefined
    if (previousRetry >= policy.maxRetries) return undefined
  }
  const retry = previousRetry + 1
  let delayMs: number
  if (failure.providerRetryAfterMs !== undefined
    && Number.isFinite(failure.providerRetryAfterMs)
    && failure.providerRetryAfterMs > 0) {
    if (failure.providerRetryAfterMs > policy.maxDelayMs) {
      if (policy.mode === 'normal') return undefined
      delayMs = localDelay(policy, retry, internals.random ?? Math.random)
    } else {
      delayMs = failure.providerRetryAfterMs
    }
  } else {
    delayMs = localDelay(policy, retry, internals.random ?? Math.random)
  }
  return {
    policyKey: capturedRetryPolicyKey(policy),
    retry,
    delayMs,
  }
}

/**
 * Wait for a scheduled retry unless cancellation wins.
 * @param delayMs - non-negative delay selected by {@link nextCapturedRetry}.
 * @param signal - caller and lifecycle cancellation signal.
 * @returns `true` after the delay, or `false` when cancellation wins.
 */
export function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError('delayMs must be finite and non-negative')
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
