import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentDriverId, SessionId } from '@deepseek-ai/dsh-session'
import {
  digestSessionEvents,
  RestartHandoffStore,
  type AgentHandoffRecord,
} from '@deepseek-ai/dsh-agent'

function record(generation: string, leaseExpiresAt: number): AgentHandoffRecord {
  return {
    version: 1,
    generation,
    resident: true,
    sessionId: SessionId('handoff-session'),
    driverId: AgentDriverId('handoff-driver'),
    eventSeq: 0,
    eventDigest: digestSessionEvents([]),
    leaseExpiresAt,
  }
}

describe('restart handoff sidecar', () => {
  it('records explicit intent, atomically commits one generation, and rejects a double claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-sidecar-'))
    try {
      const store = new RestartHandoffStore({ directory })
      const leaseExpiresAt = Date.now() + 10_000
      await expect(store.begin('sidecar-generation', leaseExpiresAt)).resolves.toMatchObject({
        generation: 'sidecar-generation',
        phase: 'requested',
      })
      expect(JSON.parse(await readFile(join(directory, 'sidecar-generation.json'), 'utf8'))).toMatchObject({
        version: 1,
        generation: 'sidecar-generation',
        phase: 'requested',
        records: [],
      })
      await expect(store.begin('other-generation', leaseExpiresAt)).rejects.toThrow('already active')

      await store.publish('sidecar-generation', [record('sidecar-generation', leaseExpiresAt)])
      const candidate = (await store.list())[0]
      if (candidate === undefined) throw new Error('expected one committed handoff record')
      const claimed = await store.claim(candidate, 'next-generation')
      await expect(store.claim(candidate, 'other-generation')).rejects.toThrow('claimed by another generation')
      await store.complete(claimed, 'next-generation')
      await expect(store.list()).resolves.toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allows an expired claim to be recovered without changing the record identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-sidecar-expired-'))
    try {
      const store = new RestartHandoffStore({ directory })
      const leaseExpiresAt = Date.now() - 1
      await store.begin('expired-generation', leaseExpiresAt)
      await store.publish('expired-generation', [record('expired-generation', leaseExpiresAt)])
      const candidate = (await store.list())[0]
      if (candidate === undefined) throw new Error('expected one committed handoff record')
      await store.claim(candidate, 'old-generation')
      await expect(store.claim(candidate, 'new-generation')).resolves.toMatchObject({
        sessionId: SessionId('handoff-session'),
        generation: 'expired-generation',
        claimedBy: 'new-generation',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers a lock left by a dead generation before publishing intent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-sidecar-lock-'))
    try {
      await writeFile(join(directory, 'begin-lock.json.lock'), JSON.stringify({
        owner: '2147483647:dead-generation',
        createdAt: Date.now(),
      }))
      const store = new RestartHandoffStore({ directory })
      await expect(store.begin('lock-recovery', Date.now() + 10_000)).resolves.toMatchObject({
        generation: 'lock-recovery',
        phase: 'requested',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not recover a lock owned by a live process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-sidecar-live-lock-'))
    try {
      await writeFile(join(directory, 'begin-lock.json.lock'), JSON.stringify({
        owner: `${String(process.pid)}:live-generation`,
        createdAt: Date.now(),
      }))
      const store = new RestartHandoffStore({ directory })
      await expect(store.begin('live-lock', Date.now() + 10_000)).rejects.toThrow('busy')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
