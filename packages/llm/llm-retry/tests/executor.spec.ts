import { describe, expect, it, vi } from 'vitest'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import {
  capturedRetryPolicyKey,
  nextCapturedRetry,
  waitForRetryDelay,
} from '../src/executor.ts'

const normal: ResolvedRetryPolicy = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['SERVER', 'TIMEOUT'],
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.2,
}
const failure: LlmFailure = { code: 'SERVER', message: 'failed' }

describe('captured retry policy executor', () => {
  it('uses the captured normal policy without another configuration layer', () => {
    expect(nextCapturedRetry(normal, failure, 0, { random: () => 0 })).toEqual({
      policyKey: capturedRetryPolicyKey(normal),
      retry: 1,
      delayMs: 80,
    })
    expect(nextCapturedRetry(normal, failure, 1, { random: () => 0.5 })).toMatchObject({
      retry: 2,
      delayMs: 200,
    })
    expect(nextCapturedRetry(normal, failure, 2)).toBeUndefined()
    expect(nextCapturedRetry(normal, { code: 'AUTH', message: 'denied' }, 0)).toBeUndefined()
  })

  it('honors bounded provider retry-after and rejects an excessive normal delay', () => {
    expect(nextCapturedRetry(normal, { ...failure, providerRetryAfterMs: 250 }, 0)).toMatchObject({ delayMs: 250 })
    expect(nextCapturedRetry(normal, { ...failure, providerRetryAfterMs: 1_001 }, 0)).toBeUndefined()
  })

  it('keeps always mode unbounded and falls back locally above its delay cap', () => {
    const always: ResolvedRetryPolicy = {
      mode: 'always', initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0,
    }
    expect(nextCapturedRetry(always, { code: 'AUTH', message: 'denied' }, 99)).toMatchObject({
      retry: 100,
      delayMs: 500,
    })
    expect(nextCapturedRetry(always, { ...failure, providerRetryAfterMs: 999 }, 0)).toMatchObject({
      retry: 1,
      delayMs: 100,
    })
  })

  it('cancels a scheduled delay without leaving a timer alive', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const waiting = waitForRetryDelay(1_000, controller.signal)
      controller.abort()
      await expect(waiting).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
