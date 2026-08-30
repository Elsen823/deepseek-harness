/** Captured retry execution shared by the loop and prepared-call consumers. */

import { describe, expect, it, vi } from 'vitest'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import {
  capturedRetryPolicyKey,
  nextCapturedRetry,
  waitForRetryDelay,
} from '../src/executor.ts'

const normal: ResolvedRetryPolicy = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'TRANSPORT'],
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.1,
}
const failure = { code: 'RATE_LIMIT', message: 'slow down' }

describe('captured retry executor', () => {
  it('uses the captured normal policy and stable policy identity', () => {
    expect(nextCapturedRetry(normal, failure, 0, { random: () => 0 })).toEqual({
      policyKey: capturedRetryPolicyKey(normal),
      retry: 1,
      delayMs: 90,
    })
    expect(nextCapturedRetry(normal, failure, 1, { random: () => 0.5 })).toMatchObject({
      retry: 2,
      delayMs: 200,
    })
    expect(nextCapturedRetry(normal, failure, 2)).toBeUndefined()
    expect(nextCapturedRetry(normal, { code: 'AUTH', message: 'denied' }, 0)).toBeUndefined()
  })

  it('honors bounded provider delay and always-policy fallback', () => {
    expect(nextCapturedRetry(normal, { ...failure, providerRetryAfterMs: 250 }, 0)).toMatchObject({ delayMs: 250 })
    expect(nextCapturedRetry(normal, { ...failure, providerRetryAfterMs: 1_001 }, 0)).toBeUndefined()
    const always: ResolvedRetryPolicy = {
      mode: 'always', initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0,
    }
    expect(nextCapturedRetry(always, { code: 'AUTH', message: 'denied' }, 99)).toMatchObject({
      retry: 100, delayMs: 100,
    })
    expect(nextCapturedRetry(always, { ...failure, providerRetryAfterMs: 999 }, 0)).toMatchObject({
      retry: 1, delayMs: 10,
    })
  })

  it('validates retry count and delay', async () => {
    expect(() => nextCapturedRetry(normal, failure, -1)).toThrow(/previousRetry/u)
    expect(() => waitForRetryDelay(-1, new AbortController().signal)).toThrow(/delayMs/u)

    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const waiting = waitForRetryDelay(1_000, controller.signal)
      controller.abort()
      await expect(waiting).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
