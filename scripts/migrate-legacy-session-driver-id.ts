#!/usr/bin/env node
/**
 * One-off, dry-run-gated migration for legacy version-0 JSONL Session headers.
 *
 * The dry run records exact source identities and hashes. Apply accepts only
 * candidates from that manifest, revalidates their complete logs, creates a
 * same-directory hard-link backup, and atomically replaces the original path.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  link, lstat, open, readFile, readdir, rename, rm, stat, type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { decodeStorageRecord, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, logPath, projectKey,
} from '../packages/session/session-persistence-jsonl/src/format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, scanZstdFrames,
} from '../packages/session/session-persistence-jsonl/src/zstd.ts'

const MANIFEST_VERSION = 1
const TARGET_DRIVER_ID = 'dsh'
const LOG_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Encoding = 'plain' | 'zstd'
type EntryStatus =
  | 'eligible'
  | 'migrated'
  | 'skipped-active'
  | 'skipped-already-migrated'
  | 'skipped-foreign-version'
  | 'skipped-unsupported-event'
  | 'skipped-malformed'
  | 'skipped-changing'
  | 'skipped-source-mismatch'
  | 'skipped-non-regular'
  | 'replacement-published-unverified'
  | 'error'

interface FileIdentity {
  dev: string
  ino: string
  size: string
  mode: number
  uid: number
  gid: number
  nlink: string
  atimeNs: string
  mtimeNs: string
  ctimeNs: string
}

interface ManifestEntry {
  path: string
  relativePath: string
  encoding: Encoding
  status: EntryStatus
  reason?: string
  sessionId?: string
  source?: {
    identity: FileIdentity
    sha256: string
    bytes: number
  }
  target?: {
    sha256: string
    bytes: number
  }
  backupPath?: string
}

interface MigrationManifest {
  manifestVersion: 1
  planId: string
  scriptSha256: string
  mode: 'dry-run' | 'apply'
  root: string
  targetDriverId: 'dsh'
  skippedSessionIds: string[]
  sourceDryRunManifest?: string
  applyJournalPath?: string
  startedAt: string
  completedAt: string
  summary: Record<EntryStatus, number>
  entries: ManifestEntry[]
}

interface StableRead {
  buffer: Buffer
  identity: FileIdentity
  stats: BigIntStats
  sha256: string
}

interface MigrationPlan {
  sessionId: string
  encoding: Encoding
  replacement: Buffer
  targetSha256: string
}

interface DryRunOptions {
  mode: 'dry-run'
  root: string
  manifestPath: string
  skippedSessionIds: ReadonlySet<string>
}

interface ApplyOptions {
  mode: 'apply'
  manifestPath: string
  dryRunManifestPath: string
  confirmedQuiesced: true
}

export type MigrationOptions = DryRunOptions | ApplyOptions

function identityOf(value: BigIntStats): FileIdentity {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mode: Number(value.mode),
    uid: Number(value.uid),
    gid: Number(value.gid),
    nlink: String(value.nlink),
    atimeNs: String(value.atimeNs),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
  }
}

function sameRevision(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameContentIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function stableRead(path: string): Promise<StableRead | undefined> {
  const pathBefore = await lstat(path, { bigint: true })
  if (!pathBefore.isFile()) return undefined
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(path, flags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameRevision(identityOf(pathBefore), identityOf(before))) {
      throw new Error('path changed before the bound file descriptor was read')
    }
    const buffer = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    const beforeIdentity = identityOf(before)
    if (!sameRevision(beforeIdentity, identityOf(after))
      || !sameRevision(beforeIdentity, identityOf(pathAfter))) {
      throw new Error('file changed during read')
    }
    return { buffer, identity: beforeIdentity, stats: after, sha256: sha256(buffer) }
  } finally {
    await handle.close()
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function parseLegacyHeader(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('header line is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('header is not a JSON object')
  }
  const header = value as Record<string, unknown>
  if (header.type !== 'session') throw new Error('first line is not a Session header')
  if (typeof header.version !== 'number') throw new Error('header version is not a number')
  if (typeof header.id !== 'string' || header.id.length === 0) throw new Error('header id is not a non-empty string')
  if (!isNonNegativeSafeInteger(header.createdAt)) throw new Error('header createdAt is invalid')
  if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))) {
    throw new Error('header cwd is not an absolute path')
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== 'string') {
    throw new Error('header parentSession is not a string')
  }
  if (header.seedLength !== undefined && !isNonNegativeSafeInteger(header.seedLength)) {
    throw new Error('header seedLength is invalid')
  }
  if (header.origin !== undefined && header.origin !== 'subagent') throw new Error('header origin is invalid')
  if (!isNonNegativeSafeInteger(header.delegationDepth)) throw new Error('header delegationDepth is invalid')
  if (header.agentPreset !== undefined && typeof header.agentPreset !== 'string') {
    throw new Error('header agentPreset is not a string')
  }
  if (Object.hasOwn(header, 'sandboxMode') || Object.hasOwn(header, 'approvalPolicy')) {
    throw new Error('header contains retired policy baseline fields')
  }
  if (Object.hasOwn(header, 'driverId')
    && (typeof header.driverId !== 'string' || header.driverId.length === 0)) {
    throw new Error('header driverId is invalid')
  }
  return header
}

function addDriverId(header: Record<string, unknown>): string {
  const migrated: Record<string, unknown> = {}
  let inserted = false
  for (const [key, value] of Object.entries(header)) {
    migrated[key] = value
    if (key === 'version') {
      migrated.driverId = TARGET_DRIVER_ID
      inserted = true
    }
  }
  if (!inserted) throw new Error('header has no version field')
  return JSON.stringify(migrated) + '\n'
}

class UnsupportedEventError extends Error {}

class EventRowsValidator {
  private remainder = Buffer.alloc(0)
  private nextSeq = 0
  private line = 1

  write(chunk: Buffer): void {
    const input = this.remainder.length === 0 ? chunk : Buffer.concat([this.remainder, chunk])
    let start = 0
    for (let newline = input.indexOf(0x0A); newline !== -1; newline = input.indexOf(0x0A, start)) {
      const row = input.subarray(start, newline)
      this.line += 1
      if (row.length === 0) throw new Error(`empty event row at line ${this.line}`)
      let decoded
      try {
        decoded = decodeStorageRecord(JSON.parse(row.toString('utf8')))
      } catch (error) {
        throw new Error(`invalid event row at line ${this.line}`, { cause: error })
      }
      for (const event of decoded) {
        if (event.seq !== this.nextSeq) {
          throw new Error(`event sequence gap at line ${this.line}: expected ${this.nextSeq}, got ${event.seq}`)
        }
        if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
          throw new UnsupportedEventError(
            `unknown required event type ${JSON.stringify(event.type)} at line ${this.line}`,
          )
        }
        this.nextSeq += 1
      }
      start = newline + 1
    }
    this.remainder = Buffer.from(input.subarray(start))
  }

  finish(): void {
    if (this.remainder.length !== 0) throw new Error('log ends with a torn JSONL event row')
  }
}

function assertStoredPath(root: string, path: string, header: Record<string, unknown>, encoding: Encoding): void {
  const id = header.id as string
  const cwd = header.cwd as string | undefined
  const expected = logPath(root, cwd, id as never, encoding === 'zstd' ? 'zstd' : 'none')
  if (resolve(path) !== resolve(expected)) {
    throw new Error(`header id and cwd identify ${JSON.stringify(expected)}, not this artifact`)
  }
  if (basename(dirname(path)) !== encodeSegment(id)) throw new Error('session directory does not match encoded header id')
  const expectedProject = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  if (basename(dirname(dirname(path))) !== expectedProject) throw new Error('project directory does not match header cwd')
}

async function planMigration(root: string, path: string, source: Buffer): Promise<MigrationPlan | EntryStatus> {
  const encoding: Encoding = path.endsWith('.zstd') ? 'zstd' : 'plain'
  let headerText: string
  let replacement: Buffer
  const validator = new EventRowsValidator()

  if (encoding === 'zstd') {
    const { frames, tornStart } = scanZstdFrames(source)
    if (tornStart !== undefined) throw new Error(`incomplete Zstandard frame starts at byte ${tornStart}`)
    const firstFrame = frames[0]
    if (firstFrame === undefined) throw new Error('empty Zstandard log')
    const decoder = createZstdFrameDecoder()
    try {
      const plaintext = decoder.decode(source, frames)
      const first = plaintext.next()
      if (first.done || first.value.length === 0 || first.value.indexOf(0x0A) !== first.value.length - 1) {
        throw new Error('first Zstandard frame is not exactly one newline-terminated header')
      }
      headerText = first.value.subarray(0, -1).toString('utf8')
      for (const frame of plaintext) validator.write(frame)
      validator.finish()
    } finally {
      decoder.close()
    }
    const header = parseLegacyHeader(headerText)
    assertStoredPath(root, path, header, encoding)
    if (header.driverId !== undefined) return 'skipped-already-migrated'
    if (header.version !== 0) return 'skipped-foreign-version'
    const headerFrame = await compressZstdFrame(addDriverId(header))
    replacement = Buffer.concat([headerFrame, source.subarray(firstFrame.end)])
    return { sessionId: header.id as string, encoding, replacement, targetSha256: sha256(replacement) }
  }

  const newline = source.indexOf(0x0A)
  if (newline === -1) throw new Error('plaintext log has no complete header line')
  headerText = source.subarray(0, newline).toString('utf8')
  validator.write(source.subarray(newline + 1))
  validator.finish()
  const header = parseLegacyHeader(headerText)
  assertStoredPath(root, path, header, encoding)
  if (header.driverId !== undefined) return 'skipped-already-migrated'
  if (header.version !== 0) return 'skipped-foreign-version'
  replacement = Buffer.concat([Buffer.from(addDriverId(header)), source.subarray(newline + 1)])
  return { sessionId: header.id as string, encoding, replacement, targetSha256: sha256(replacement) }
}

async function discoverLogs(root: string): Promise<string[]> {
  const found: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (LOG_NAMES.has(entry.name)) found.push(path)
    }
  }
  return found.sort()
}

function emptySummary(): Record<EntryStatus, number> {
  return {
    eligible: 0,
    migrated: 0,
    'skipped-active': 0,
    'skipped-already-migrated': 0,
    'skipped-foreign-version': 0,
    'skipped-unsupported-event': 0,
    'skipped-malformed': 0,
    'skipped-changing': 0,
    'skipped-source-mismatch': 0,
    'skipped-non-regular': 0,
    'replacement-published-unverified': 0,
    error: 0,
  }
}

function summarize(entries: readonly ManifestEntry[]): Record<EntryStatus, number> {
  const summary = emptySummary()
  for (const entry of entries) summary[entry.status] += 1
  return summary
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`artifact path escapes root: ${path}`)
  }
  return value
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeManifest(path: string, manifest: MigrationManifest): Promise<void> {
  const absolute = resolve(path)
  const temporary = `${absolute}.${randomBytes(6).toString('hex')}.tmp`
  const content = JSON.stringify(manifest, null, 2) + '\n'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  let published = false
  try {
    await link(temporary, absolute)
    published = true
    await syncDirectory(dirname(absolute))
  } finally {
    await rm(temporary, { force: true })
    if (published) await syncDirectory(dirname(absolute))
  }
}

async function appendJournal(handle: FileHandle, record: Record<string, unknown>): Promise<void> {
  await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
  await handle.sync()
}

async function readDryRunManifest(path: string, expectedScriptSha256: string): Promise<MigrationManifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dry-run manifest is not a JSON object')
  }
  const parsed = value as Partial<MigrationManifest>
  if (parsed.manifestVersion !== MANIFEST_VERSION || parsed.mode !== 'dry-run') {
    throw new Error('apply requires a version-1 dry-run manifest')
  }
  if (parsed.targetDriverId !== TARGET_DRIVER_ID || typeof parsed.root !== 'string' || !isAbsolute(parsed.root)) {
    throw new Error('dry-run manifest has an invalid target driver or root')
  }
  if (typeof parsed.planId !== 'string'
    || !UUID_PATTERN.test(parsed.planId)
    || parsed.scriptSha256 !== expectedScriptSha256
    || !Array.isArray(parsed.skippedSessionIds)
    || !parsed.skippedSessionIds.every(id => typeof id === 'string')
    || !Array.isArray(parsed.entries)) {
    throw new Error('dry-run manifest has an invalid plan, script digest, or candidate inventory')
  }
  return parsed as MigrationManifest
}

class ReplacementError extends Error {
  constructor(
    message: string,
    readonly backupPath: string | undefined,
    readonly replaced: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

async function replaceAtomically(
  root: string,
  path: string,
  source: StableRead,
  plan: MigrationPlan,
  planId: string,
): Promise<string> {
  const directory = dirname(path)
  const backupPath = `${path}.pre-driver-id-${planId}.bak`
  const temporary = `${path}.driver-id-${planId}.${randomBytes(6).toString('hex')}.tmp`
  const preservedMode = Number(source.stats.mode & 0o7777n)
  const handle = await open(temporary, 'wx', preservedMode)
  try {
    await handle.writeFile(plan.replacement)
    await handle.sync()
    if (Number(source.stats.uid) !== process.getuid?.() || Number(source.stats.gid) !== process.getgid?.()) {
      await handle.chown(Number(source.stats.uid), Number(source.stats.gid))
    }
    await handle.chmod(preservedMode)
    await handle.utimes(Number(source.stats.atimeNs) / 1e9, Number(source.stats.mtimeNs) / 1e9)
    await handle.sync()
  } finally {
    await handle.close()
  }

  let linked = false
  let replaced = false
  try {
    const staged = await stableRead(temporary)
    if (staged === undefined || staged.sha256 !== plan.targetSha256) {
      throw new Error('staged replacement bytes do not match the migration plan')
    }
    const stagedValidation = await planMigration(root, path, staged.buffer)
    if (stagedValidation !== 'skipped-already-migrated') {
      throw new Error('staged replacement is not a valid migrated Session log')
    }
    const immediatelyBefore = identityOf(await lstat(path, { bigint: true }))
    if (!sameRevision(source.identity, immediatelyBefore)) throw new Error('file changed after validation')
    await link(path, backupPath)
    linked = true
    await syncDirectory(directory)
    const afterLink = identityOf(await lstat(path, { bigint: true }))
    if (!sameContentIdentity(source.identity, afterLink)) throw new Error('file changed while backup was created')
    const backup = identityOf(await lstat(backupPath, { bigint: true }))
    if (!sameContentIdentity(afterLink, backup)) throw new Error('hard-link backup does not reference the source inode')
    const immediatelyBeforeRename = identityOf(await lstat(path, { bigint: true }))
    if (!sameContentIdentity(afterLink, immediatelyBeforeRename)) throw new Error('file changed before atomic replacement')
    await rename(temporary, path)
    replaced = true
    await syncDirectory(directory)
    return backupPath
  } catch (error) {
    if (!replaced) await rm(temporary, { force: true })
    throw new ReplacementError(
      error instanceof Error ? error.message : String(error),
      linked ? backupPath : undefined,
      replaced,
      { cause: error },
    )
  }
}

async function inspectCandidate(
  root: string,
  path: string,
  skippedSessionIds: ReadonlySet<string>,
): Promise<{ entry: ManifestEntry; source?: StableRead; plan?: MigrationPlan }> {
  const encoding: Encoding = path.endsWith('.zstd') ? 'zstd' : 'plain'
  const base: Pick<ManifestEntry, 'path' | 'relativePath' | 'encoding'> = {
    path,
    relativePath: safeRelative(root, path),
    encoding,
  }
  const pathSessionId = basename(dirname(path))
  if (skippedSessionIds.has(pathSessionId)) {
    return {
      entry: {
        ...base,
        status: 'skipped-active',
        sessionId: pathSessionId,
        reason: 'session directory is on the explicit active-session skip list; file was not opened',
      },
    }
  }
  let source: StableRead | undefined
  try {
    source = await stableRead(path)
    if (source === undefined) return { entry: { ...base, status: 'skipped-non-regular' } }
  } catch (error) {
    return {
      entry: { ...base, status: 'skipped-changing', reason: error instanceof Error ? error.message : String(error) },
    }
  }

  try {
    const result = await planMigration(root, path, source.buffer)
    if (typeof result === 'string') {
      return {
        entry: {
          ...base,
          status: result,
          source: { identity: source.identity, sha256: source.sha256, bytes: source.buffer.length },
        },
      }
    }
    const common = {
      ...base,
      sessionId: result.sessionId,
      source: { identity: source.identity, sha256: source.sha256, bytes: source.buffer.length },
      target: { sha256: result.targetSha256, bytes: result.replacement.length },
    }
    if (skippedSessionIds.has(result.sessionId)) {
      return { entry: { ...common, status: 'skipped-active', reason: 'session id is on the explicit active-session skip list' } }
    }
    return { entry: { ...common, status: 'eligible' }, source, plan: result }
  } catch (error) {
    return {
      entry: {
        ...base,
        status: error instanceof UnsupportedEventError ? 'skipped-unsupported-event' : 'skipped-malformed',
        reason: error instanceof Error ? error.message : String(error),
        source: { identity: source.identity, sha256: source.sha256, bytes: source.buffer.length },
      },
    }
  }
}

export async function migrateLegacySessionDriverId(options: MigrationOptions): Promise<MigrationManifest> {
  if (process.platform === 'win32') throw new Error('this one-off hard-link migration supports POSIX filesystems only')
  const startedAt = new Date().toISOString()
  const scriptSha256 = sha256(await readFile(import.meta.filename))
  let root: string
  let skippedSessionIds: Set<string>
  let planId: string
  let paths: string[]
  let dryRunByPath: Map<string, ManifestEntry>
  let sourceDryRunManifest: string | undefined
  if (options.mode === 'dry-run') {
    root = resolve(options.root)
    skippedSessionIds = new Set(options.skippedSessionIds)
    planId = randomUUID()
    paths = []
    dryRunByPath = new Map()
  } else {
    sourceDryRunManifest = resolve(options.dryRunManifestPath)
    const dryRun = await readDryRunManifest(sourceDryRunManifest, scriptSha256)
    root = resolve(dryRun.root)
    skippedSessionIds = new Set(dryRun.skippedSessionIds)
    planId = dryRun.planId
    paths = dryRun.entries.filter(entry => entry.status === 'eligible').map(entry => entry.path)
    dryRunByPath = new Map(dryRun.entries.map(entry => [entry.path, entry]))
  }
  const manifestPath = resolve(options.manifestPath)
  const manifestRelative = relative(root, manifestPath)
  if (manifestRelative === '' || (!manifestRelative.startsWith(`..${sep}`) && manifestRelative !== '..')) {
    throw new Error('manifest must be outside the Session artifact root')
  }
  const entries: ManifestEntry[] = []

  if (!(await stat(root)).isDirectory()) throw new Error(`session root is not a directory: ${root}`)
  if (options.mode === 'dry-run') paths = await discoverLogs(root)
  const applyJournalPath = options.mode === 'apply' ? `${manifestPath}.journal.jsonl` : undefined
  const journal = applyJournalPath === undefined ? undefined : await open(applyJournalPath, 'wx', 0o600)
  if (journal !== undefined) {
    await appendJournal(journal, {
      record: 'run-start',
      planId,
      scriptSha256,
      root,
      sourceDryRunManifest,
      targetDriverId: TARGET_DRIVER_ID,
      confirmedQuiesced: true,
    })
  }

  try {
    for (const path of paths) {
      const inspected = await inspectCandidate(root, path, skippedSessionIds)
      let entry = inspected.entry
      if (options.mode === 'apply' && entry.status === 'eligible') {
        const prior = dryRunByPath.get(path)
        const source = inspected.source
        const plan = inspected.plan
        if (source === undefined || plan === undefined) {
          entry = { ...entry, status: 'error', reason: 'eligible candidate is missing its validated source or replacement plan' }
        } else if (prior?.source === undefined
        || prior.source.sha256 !== source.sha256
        || !sameRevision(prior.source.identity, source.identity)) {
          entry = { ...entry, status: 'skipped-source-mismatch', reason: 'source identity or SHA-256 differs from dry run' }
        } else {
          if (journal === undefined) throw new Error('apply journal is unavailable before mutation')
          await appendJournal(journal, {
            record: 'intent',
            planId,
            path,
            relativePath: entry.relativePath,
            sessionId: entry.sessionId,
            source: entry.source,
            target: entry.target,
          })
          let backupPath: string | undefined
          try {
            backupPath = await replaceAtomically(root, path, source, plan, planId)
            const migrated = await stableRead(path)
            if (migrated === undefined || migrated.sha256 !== plan.targetSha256) {
              throw new Error('atomic replacement did not publish the planned target bytes')
            }
            entry = { ...entry, status: 'migrated', backupPath }
          } catch (error) {
            const replacement = error instanceof ReplacementError ? error : undefined
            const recordedBackupPath = backupPath ?? replacement?.backupPath
            const reason = error instanceof Error ? error.message : String(error)
            const published = replacement?.replaced === true
              || (replacement === undefined && backupPath !== undefined)
            entry = recordedBackupPath === undefined
              ? { ...entry, status: 'error', reason }
              : {
                ...entry,
                status: published ? 'replacement-published-unverified' : 'error',
                reason,
                backupPath: recordedBackupPath,
              }
          }
        }
      }
      entries.push(entry)
      if (journal !== undefined) {
        await appendJournal(journal, {
          record: 'outcome',
          planId,
          path,
          status: entry.status,
          reason: entry.reason,
          backupPath: entry.backupPath,
        })
      }
    }
    if (journal !== undefined) {
      await appendJournal(journal, { record: 'run-complete', planId, summary: summarize(entries) })
    }
  } finally {
    await journal?.close()
  }

  const manifest: MigrationManifest = {
    manifestVersion: MANIFEST_VERSION,
    planId,
    scriptSha256,
    mode: options.mode,
    root,
    targetDriverId: TARGET_DRIVER_ID,
    skippedSessionIds: [...skippedSessionIds].sort(),
    ...sourceDryRunManifest === undefined ? {} : { sourceDryRunManifest },
    ...applyJournalPath === undefined ? {} : { applyJournalPath },
    startedAt,
    completedAt: new Date().toISOString(),
    summary: summarize(entries),
    entries,
  }
  await writeManifest(manifestPath, manifest)
  return manifest
}

export function parseArgs(argv: readonly string[]): MigrationOptions {
  let apply = false
  let root: string | undefined
  let manifestPath: string | undefined
  let dryRunManifestPath: string | undefined
  let confirmedQuiesced = false
  const skipped = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--apply') {
      apply = true
    } else if (arg === '--confirm-quiesced') {
      confirmedQuiesced = true
    } else if (arg === '--root' && value !== undefined) {
      root = value
      index += 1
    } else if (arg === '--manifest' && value !== undefined) {
      manifestPath = value
      index += 1
    } else if (arg === '--from-dry-run' && value !== undefined) {
      dryRunManifestPath = value
      index += 1
    } else if (arg === '--skip-session-id' && value !== undefined) {
      skipped.add(value)
      index += 1
    } else {
      throw new Error(`unknown or incomplete argument: ${String(arg)}`)
    }
  }
  if (manifestPath === undefined) throw new Error('--manifest is required')
  if (apply) {
    if (dryRunManifestPath === undefined) throw new Error('--apply requires --from-dry-run')
    if (!confirmedQuiesced) {
      throw new Error('--apply requires --confirm-quiesced after every process that can append Session logs has stopped')
    }
    if (root !== undefined) throw new Error('--root is read from the dry-run manifest during apply')
    return {
      mode: 'apply',
      manifestPath: resolve(manifestPath),
      dryRunManifestPath: resolve(dryRunManifestPath),
      confirmedQuiesced: true,
    }
  }
  if (!confirmedQuiesced && skipped.size === 0) {
    throw new Error('dry-run requires --confirm-quiesced or at least one --skip-session-id for every active writer')
  }
  if (confirmedQuiesced && skipped.size > 0) {
    throw new Error('--confirm-quiesced cannot be combined with --skip-session-id')
  }
  if (root === undefined) throw new Error('dry-run requires --root')
  if (dryRunManifestPath !== undefined) throw new Error('--from-dry-run is valid only with --apply')
  return { mode: 'dry-run', root: resolve(root), manifestPath: resolve(manifestPath), skippedSessionIds: skipped }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await migrateLegacySessionDriverId(options)
  console.log(JSON.stringify({
    manifest: resolve(options.manifestPath),
    mode: manifest.mode,
    planId: manifest.planId,
    summary: manifest.summary,
  }, null, 2))
  if (manifest.summary.error > 0 || manifest.summary['replacement-published-unverified'] > 0) process.exitCode = 2
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main()
}
