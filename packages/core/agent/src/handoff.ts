/**
 * Process-generation handoff records for resident Agent Drivers.
 *
 * Handoff state is intentionally kept outside the Session event log. A record
 * identifies the exact durable Session prefix and Driver generation that may
 * be adopted by a later process; it does not make a process-local Agent or
 * Cordis scope durable.
 *
 * @module @deepseek-ai/dsh-agent/handoff
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  AgentDriverId,
  isJsonValue,
  SessionId,
  snapshotJsonValue,
} from '@deepseek-ai/dsh-session'
import type { JsonValue, Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Version of the process-generation handoff sidecar format. */
export const AGENT_HANDOFF_FORMAT_VERSION = 1 as const

/** One explicit restart request written before any Agent quiescence begins. */
export interface AgentHandoffIntent {
  /** Sidecar format version. */
  readonly version: typeof AGENT_HANDOFF_FORMAT_VERSION
  /** Caller-selected generation id. */
  readonly generation: string
  /** Intent lifecycle phase. */
  readonly phase: 'requested' | 'committed' | 'rejected'
  /** Unix epoch milliseconds when the intent was written. */
  readonly createdAt: number
  /** Lease expiry for the committed generation. */
  readonly leaseExpiresAt: number
  /** Rejection explanation, when the handoff did not commit. */
  readonly reason?: string
}

/** Driver-produced opaque state captured in one generic handoff record. */
export interface AgentDriverHandoff {
  /** JSON state required by the next Driver generation, when any. */
  readonly state?: JsonValue
  /**
   * Commit the Driver's process-local handoff barrier after the sidecar is
   * durably published. This hook must not dispose the prepared Agent.
   */
  commit(): void
}

/** One Session adoption claim published outside the model-visible log. */
export interface AgentHandoffRecord {
  /** Sidecar format version. */
  readonly version: typeof AGENT_HANDOFF_FORMAT_VERSION
  /** Generation whose restart intent owns this record. */
  readonly generation: string
  /** Explicit resident opt-in marker. */
  readonly resident: true
  /** Exact DSH Session identity. */
  readonly sessionId: SessionId
  /** Exact immutable Driver binding from the Session header. */
  readonly driverId: AgentDriverId
  /** Number of durable events flushed before publication. */
  readonly eventSeq: number
  /** SHA-256 digest of the flushed event prefix. */
  readonly eventDigest: string
  /** Lease expiry for adoption and stale-claim recovery. */
  readonly leaseExpiresAt: number
  /** Driver-owned JSON state, if its handoff requires one. */
  readonly state?: JsonValue
  /** Process generation currently claiming the record. */
  readonly claimedBy?: string
  /** Unix epoch milliseconds when the claim was written. */
  readonly claimedAt?: number
  /** Process generation that completed adoption. */
  readonly adoptedBy?: string
  /** Unix epoch milliseconds when adoption completed. */
  readonly adoptedAt?: number
}

/** Validated handoff-store configuration. */
export interface AgentHandoffStoreOptions {
  /** Absolute owner-only directory for generation manifests. */
  readonly directory: string
}

/** Candidate adoption failure retained while other Sessions are adopted. */
export interface AgentHandoffFailure {
  /** Exact record that could not be adopted. */
  readonly record: AgentHandoffRecord
  /** Failure from Driver preparation or identity validation. */
  readonly error: unknown
}

/** Result of one next-generation adoption pass. */
export interface AgentHandoffAdoption<T = unknown> {
  /** Handles published for successfully adopted Sessions. */
  readonly handles: readonly T[]
  /** Records not completed; a transferred handle keeps its claim fenced for recovery. */
  readonly failures: readonly AgentHandoffFailure[]
}

interface HandoffManifest {
  readonly version: typeof AGENT_HANDOFF_FORMAT_VERSION
  readonly generation: string
  readonly phase: 'requested' | 'committed' | 'rejected'
  readonly createdAt: number
  readonly leaseExpiresAt: number
  readonly records: AgentHandoffRecord[]
  readonly reason?: string
}

const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Validate one bounded positive timeout supplied by a Loader configuration. */
function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Agent handoff ${name} must be a non-negative safe integer`)
  }
}

/** Validate one externally read sidecar generation id. */
function assertGeneration(generation: string): void {
  if (!GENERATION_PATTERN.test(generation)) {
    throw new TypeError('Agent handoff generation must contain 1-128 letters, digits, underscores, or hyphens')
  }
}

/**
 * Return one deterministic digest for a Session's current immutable event prefix.
 * @param events - events included in the durable prefix.
 * @returns the SHA-256 digest of the serialized events.
 */
export function digestSessionEvents(events: readonly SessionEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex')
}

/**
 * Return one deterministic digest for a Session's current immutable event prefix.
 * @param session - Session whose events form the digest input.
 * @returns the SHA-256 digest of the serialized Session events.
 */
export function digestSession(session: Session): string {
  return digestSessionEvents(session.events)
}

/** Validate and detach one JSON handoff state value. */
function snapshotState(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined || !isJsonValue(snapshot)) {
    throw new TypeError('Agent Driver handoff state must be lossless JSON')
  }
  return snapshot as JsonValue
}

/** Validate one sidecar record loaded from disk before it reaches a Driver. */
function validateRecord(value: unknown, expectedGeneration?: string): AgentHandoffRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent handoff record must be a plain JSON record')
  }
  const record = value as Record<string, unknown>
  if (record.version !== AGENT_HANDOFF_FORMAT_VERSION) throw new TypeError('unsupported Agent handoff record version')
  if (typeof record.generation !== 'string') throw new TypeError('Agent handoff record generation must be a string')
  assertGeneration(record.generation)
  if (expectedGeneration !== undefined && record.generation !== expectedGeneration) {
    throw new Error(`Agent handoff generation mismatch: expected "${expectedGeneration}", got "${record.generation}"`)
  }
  if (record.resident !== true) throw new TypeError('Agent handoff record must carry resident: true')
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) throw new TypeError('Agent handoff sessionId must be non-empty')
  if (typeof record.driverId !== 'string' || record.driverId.length === 0) throw new TypeError('Agent handoff driverId must be non-empty')
  if (typeof record.eventSeq !== 'number' || !Number.isSafeInteger(record.eventSeq) || record.eventSeq < 0) throw new TypeError('Agent handoff eventSeq must be a non-negative safe integer')
  if (typeof record.eventDigest !== 'string' || !DIGEST_PATTERN.test(record.eventDigest)) throw new TypeError('Agent handoff eventDigest must be a SHA-256 digest')
  if (typeof record.leaseExpiresAt !== 'number') throw new TypeError('Agent handoff leaseExpiresAt must be a number')
  assertTimestamp('leaseExpiresAt', record.leaseExpiresAt)
  for (const key of ['claimedAt', 'adoptedAt'] as const) {
    const timestamp = record[key]
    if (timestamp !== undefined) {
      if (typeof timestamp !== 'number') throw new TypeError(`Agent handoff ${key} must be a number`)
      assertTimestamp(key, timestamp)
    }
  }
  for (const key of ['claimedBy', 'adoptedBy'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || record[key].length === 0)) {
      throw new TypeError(`Agent handoff ${key} must be a non-empty string`)
    }
  }
  const state = snapshotState(record.state)
  const generation = record.generation
  const sessionId = SessionId(record.sessionId)
  const driverId = AgentDriverId(record.driverId)
  const eventSeq = record.eventSeq
  const eventDigest = record.eventDigest
  const leaseExpiresAt = record.leaseExpiresAt
  const claimedBy = typeof record.claimedBy === 'string' ? record.claimedBy : undefined
  const claimedAt = typeof record.claimedAt === 'number' ? record.claimedAt : undefined
  const adoptedBy = typeof record.adoptedBy === 'string' ? record.adoptedBy : undefined
  const adoptedAt = typeof record.adoptedAt === 'number' ? record.adoptedAt : undefined
  return Object.freeze({
    version: AGENT_HANDOFF_FORMAT_VERSION,
    generation,
    resident: true,
    sessionId,
    driverId,
    eventSeq,
    eventDigest,
    leaseExpiresAt,
    ...(state === undefined ? {} : { state }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(adoptedBy === undefined ? {} : { adoptedBy }),
    ...(adoptedAt === undefined ? {} : { adoptedAt }),
  })
}

/** Validate one generation manifest loaded from disk. */
function validateManifest(value: unknown, expectedGeneration?: string): HandoffManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent handoff manifest must be a plain JSON record')
  }
  const manifest = value as Record<string, unknown>
  if (manifest.version !== AGENT_HANDOFF_FORMAT_VERSION) throw new TypeError('unsupported Agent handoff manifest version')
  if (typeof manifest.generation !== 'string') throw new TypeError('Agent handoff manifest generation must be a string')
  assertGeneration(manifest.generation)
  if (expectedGeneration !== undefined && manifest.generation !== expectedGeneration) {
    throw new Error(`Agent handoff generation mismatch: expected "${expectedGeneration}", got "${manifest.generation}"`)
  }
  if (manifest.phase !== 'requested' && manifest.phase !== 'committed' && manifest.phase !== 'rejected') {
    throw new TypeError('Agent handoff manifest phase is invalid')
  }
  if (typeof manifest.createdAt !== 'number') throw new TypeError('Agent handoff manifest createdAt must be a number')
  assertTimestamp('createdAt', manifest.createdAt)
  if (typeof manifest.leaseExpiresAt !== 'number') throw new TypeError('Agent handoff manifest leaseExpiresAt must be a number')
  assertTimestamp('leaseExpiresAt', manifest.leaseExpiresAt)
  if (!Array.isArray(manifest.records)) throw new TypeError('Agent handoff manifest records must be an array')
  const generation = manifest.generation
  const records = manifest.records.map(record => validateRecord(record, generation))
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.sessionId)) throw new Error(`Agent handoff manifest contains duplicate Session "${record.sessionId}"`)
    ids.add(record.sessionId)
  }
  if (manifest.reason !== undefined && typeof manifest.reason !== 'string') throw new TypeError('Agent handoff manifest reason must be a string')
  return {
    version: AGENT_HANDOFF_FORMAT_VERSION,
    generation: manifest.generation,
    phase: manifest.phase,
    createdAt: manifest.createdAt,
    leaseExpiresAt: manifest.leaseExpiresAt,
    records,
    ...(manifest.reason === undefined ? {} : { reason: manifest.reason }),
  }
}

/** Return one manifest record's stable adoption identity. */
function sameRecord(left: AgentHandoffRecord, right: AgentHandoffRecord): boolean {
  return left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.driverId === right.driverId
    && left.eventSeq === right.eventSeq
    && left.eventDigest === right.eventDigest
    && JSON.stringify(left.state) === JSON.stringify(right.state)
}

/**
 * Atomic owner-only sidecar for explicit restart intent and Session adoption.
 * The store does not delete expired records: a later generation can inspect
 * and claim them after validating the durable Session prefix.
 */
export class RestartHandoffStore {
  /** Absolute owner-only directory containing generation manifests. */
  readonly directory: string

  /**
   * @param options - absolute directory where manifests are atomically replaced.
   */
  constructor(options: AgentHandoffStoreOptions) {
    if (!isAbsolute(options.directory)) throw new TypeError('Agent handoff directory must be an absolute path')
    if (options.directory.length === 0) throw new TypeError('Agent handoff directory must be non-empty')
    this.directory = options.directory
  }

  /** Ensure the owner-only sidecar directory exists. */
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  /** Resolve one generation manifest path after validating its filename key. */
  private path(generation: string): string {
    assertGeneration(generation)
    return join(this.directory, `${generation}.json`)
  }

  /** Atomically write one manifest through an owner-only temporary file. */
  private async writeManifest(manifest: HandoffManifest): Promise<void> {
    await this.ensureDirectory()
    const target = this.path(manifest.generation)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
      await chmod(target, 0o600)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /** Read one manifest, returning undefined when no generation exists yet. */
  private async readManifest(generation: string): Promise<HandoffManifest | undefined> {
    try {
      const content = await readFile(this.path(generation), 'utf8')
      return validateManifest(JSON.parse(content), generation)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Serialize sidecar compare-and-replace operations for one generation. */
  private async withManifestLock<T>(generation: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    const lock = `${this.path(generation)}.lock`
    const owner = `${process.pid}:${randomUUID()}`
    let acquired = false
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        await writeFile(lock, `${JSON.stringify({ owner, createdAt: Date.now() })}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        acquired = true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt === 0 && await this.recoverDeadLock(lock)) continue
        throw new Error(`Agent handoff generation "${generation}" is busy`)
      }
    }
    try {
      return await operation()
    } finally {
      await rm(lock, { force: true }).catch(() => undefined)
    }
  }

  /** Remove a lock left by a process that no longer exists. */
  private async recoverDeadLock(lock: string): Promise<boolean> {
    let content: string
    try {
      content = await readFile(lock, 'utf8')
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    let pid: number | undefined
    try {
      const value: unknown = JSON.parse(content)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const owner = (value as Record<string, unknown>).owner
        if (typeof owner === 'string') {
          const textPid = owner.slice(0, owner.indexOf(':'))
          const parsedPid = Number(textPid)
          if (Number.isSafeInteger(parsedPid) && parsedPid > 0) pid = parsedPid
        }
      }
    } catch {
      return false
    }
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
      await rm(lock, { force: true })
      return true
    }
  }

  /** List all manifest generation ids without interpreting unrelated files. */
  private async generations(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name.slice(0, -'.json'.length))
        .filter(generation => GENERATION_PATTERN.test(generation))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Write an explicit restart intent before quiescing any Agent.
   * @param generation - unique generation id for this restart request.
   * @param leaseExpiresAt - absolute lease expiry for later adoption.
   * @returns the requested intent.
   */
  async begin(generation: string, leaseExpiresAt: number): Promise<AgentHandoffIntent> {
    assertGeneration(generation)
    assertTimestamp('leaseExpiresAt', leaseExpiresAt)
    // A fixed lock serializes the active-generation scan as well as the write;
    // locking only the target filename would allow two different generations
    // to publish overlapping restart intents.
    return this.withManifestLock('begin-lock', async () => {
      const now = Date.now()
      for (const candidate of await this.generations()) {
        const existing = await this.readManifest(candidate)
        if (existing === undefined || existing.phase === 'rejected') continue
        if (existing.leaseExpiresAt > now && existing.generation !== generation) {
          throw new Error(`Agent handoff generation "${existing.generation}" is already active`)
        }
      }
      const existing = await this.readManifest(generation)
      if (existing !== undefined && existing.phase !== 'rejected' && existing.leaseExpiresAt > now) {
        throw new Error(`Agent handoff generation "${generation}" is already active`)
      }
      const intent: HandoffManifest = {
        version: AGENT_HANDOFF_FORMAT_VERSION,
        generation,
        phase: 'requested',
        createdAt: now,
        leaseExpiresAt,
        records: [],
      }
      await this.writeManifest(intent)
      return Object.freeze({ ...intent })
    })
  }

  /**
   * Publish all prepared records in one atomic committed generation.
   * @param generation - generation whose requested intent is being committed.
   * @param records - resident records captured at one quiescent point.
   * @returns the committed intent.
   */
  async publish(generation: string, records: readonly AgentHandoffRecord[]): Promise<AgentHandoffIntent> {
    return this.withManifestLock(generation, async () => {
      const existing = await this.readManifest(generation)
      if (existing === undefined || existing.phase !== 'requested') {
        throw new Error(`Agent handoff generation "${generation}" has no requested intent`)
      }
      const validated = records.map(record => validateRecord(record, generation))
      const ids = new Set<string>()
      for (const record of validated) {
        if (ids.has(record.sessionId)) throw new Error(`Agent handoff contains duplicate Session "${record.sessionId}"`)
        ids.add(record.sessionId)
      }
      const manifest: HandoffManifest = {
        ...existing,
        phase: 'committed',
        records: [...validated],
      }
      await this.writeManifest(manifest)
      return Object.freeze({
        version: AGENT_HANDOFF_FORMAT_VERSION,
        generation,
        phase: 'committed',
        createdAt: manifest.createdAt,
        leaseExpiresAt: manifest.leaseExpiresAt,
      })
    })
  }

  /**
   * Mark an explicit intent as rejected while leaving the old generation untouched.
   * @param generation - generation whose requested intent is being rejected.
   * @param reason - diagnostic reason retained in the sidecar.
   */
  async reject(generation: string, reason: string): Promise<void> {
    await this.withManifestLock(generation, async () => {
      const existing = await this.readManifest(generation)
      if (existing === undefined || existing.phase === 'committed') return
      await this.writeManifest({ ...existing, phase: 'rejected', reason, records: [] })
    })
  }

  /**
   * List every unadopted record, including records whose lease needs recovery.
   * @returns records available for adoption.
   */
  async list(): Promise<AgentHandoffRecord[]> {
    const records: AgentHandoffRecord[] = []
    for (const generation of await this.generations()) {
      const manifest = await this.readManifest(generation)
      if (manifest?.phase !== 'committed') continue
      records.push(...manifest.records.filter(record => record.adoptedBy === undefined))
    }
    return records
  }

  /**
   * Claim one exact record for a next-generation adopter.
   * @param candidate - record returned by {@link list}.
   * @param claimant - process-generation identity of the adopter.
   * @returns the current claimed record.
   */
  async claim(candidate: AgentHandoffRecord, claimant: string): Promise<AgentHandoffRecord> {
    if (claimant.length === 0) throw new TypeError('Agent handoff claimant must be non-empty')
    return this.withManifestLock(candidate.generation, async () => {
      const now = Date.now()
      const manifest = await this.readManifest(candidate.generation)
      if (manifest?.phase !== 'committed') throw new Error(`Agent handoff generation "${candidate.generation}" is not committed`)
      const index = manifest.records.findIndex(record => sameRecord(record, candidate))
      if (index < 0) throw new Error(`Agent handoff Session "${candidate.sessionId}" is stale`)
      const current = manifest.records[index]
      if (current === undefined) throw new Error(`Agent handoff Session "${candidate.sessionId}" is stale`)
      if (current.adoptedBy !== undefined) throw new Error(`Agent handoff Session "${candidate.sessionId}" was already adopted`)
      if (current.claimedBy !== undefined && current.claimedBy !== claimant && current.leaseExpiresAt > now) {
        throw new Error(`Agent handoff Session "${candidate.sessionId}" is claimed by another generation`)
      }
      const claimed = Object.freeze({ ...current, claimedBy: claimant, claimedAt: now })
      const records = [...manifest.records]
      records[index] = claimed
      await this.writeManifest({ ...manifest, records })
      return claimed
    })
  }

  /**
   * Complete one exact claim, preventing stale generations from double-adopting.
   * @param candidate - record returned by {@link claim}.
   * @param claimant - process-generation identity that owns the claim.
   * @returns the adopted record.
   */
  async complete(candidate: AgentHandoffRecord, claimant: string): Promise<AgentHandoffRecord> {
    return this.withManifestLock(candidate.generation, async () => {
      const manifest = await this.readManifest(candidate.generation)
      if (manifest?.phase !== 'committed') throw new Error(`Agent handoff generation "${candidate.generation}" is not committed`)
      const index = manifest.records.findIndex(record => sameRecord(record, candidate))
      if (index < 0) throw new Error(`Agent handoff Session "${candidate.sessionId}" is stale`)
      const current = manifest.records[index]
      if (current === undefined) throw new Error(`Agent handoff Session "${candidate.sessionId}" is stale`)
      if (current.claimedBy !== claimant) throw new Error(`Agent handoff Session "${candidate.sessionId}" is not claimed by this generation`)
      const adopted = Object.freeze({ ...current, adoptedBy: claimant, adoptedAt: Date.now() })
      const records = [...manifest.records]
      records[index] = adopted
      await this.writeManifest({ ...manifest, records })
      return adopted
    })
  }

  /**
   * Release one failed claim so a later generation can retry it.
   * @param candidate - record whose failed claim should be released.
   * @param claimant - process-generation identity that owns the claim.
   */
  async release(candidate: AgentHandoffRecord, claimant: string): Promise<void> {
    await this.withManifestLock(candidate.generation, async () => {
      const manifest = await this.readManifest(candidate.generation)
      if (manifest?.phase !== 'committed') return
      const index = manifest.records.findIndex(record => sameRecord(record, candidate))
      if (index < 0) return
      const current = manifest.records[index]
      if (current === undefined) return
      if (current.claimedBy !== claimant || current.adoptedBy !== undefined) return
      const records = [...manifest.records]
      records[index] = Object.freeze({
        version: AGENT_HANDOFF_FORMAT_VERSION,
        generation: current.generation,
        resident: true,
        sessionId: current.sessionId,
        driverId: current.driverId,
        eventSeq: current.eventSeq,
        eventDigest: current.eventDigest,
        leaseExpiresAt: current.leaseExpiresAt,
        ...(current.state === undefined ? {} : { state: current.state }),
      })
      await this.writeManifest({ ...manifest, records })
    })
  }
}
