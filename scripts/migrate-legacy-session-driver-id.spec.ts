import { afterEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { logPath } from '../packages/session/session-persistence-jsonl/src/format.ts'
import {
  compressZstdFrame, decompressZstdFrame, scanZstdFrames,
} from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import { migrateLegacySessionDriverId, parseArgs } from './migrate-legacy-session-driver-id.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-driver-id-migration-'))
  roots.push(root)
  return root
}

function legacyHeader(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id,
    createdAt: 1,
    cwd,
    delegationDepth: 0,
    ...extra,
  }) + '\n'
}

function eventRows(startSeq = 0, turn = 1): string {
  return [
    { type: 'turn/start', seq: startSeq, time: 2, data: { turn } },
    { type: 'turn/end', seq: startSeq + 1, time: 3, data: { turn, reason: { kind: 'completed' } } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
}

async function writeZstdLog(
  root: string,
  cwd: string,
  id: string,
  header: string,
  events = eventRows(),
): Promise<{ path: string; tail: Buffer }> {
  const path = logPath(root, cwd, id as never, 'zstd')
  await mkdir(dirname(path), { recursive: true })
  const headerFrame = await compressZstdFrame(header)
  const eventFrame = await compressZstdFrame(events)
  await writeFile(path, Buffer.concat([headerFrame, eventFrame]), { mode: 0o640 })
  return { path, tail: eventFrame }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('legacy Session driverId migration', () => {
  it('requires an explicit active-Session skip or complete quiescence acknowledgement', () => {
    const common = ['--root', '/tmp/sessions', '--manifest', '/tmp/dry-run.json']
    expect(() => parseArgs(common)).toThrow(
      'dry-run requires --confirm-quiesced or at least one --skip-session-id',
    )

    const activeSkipped = parseArgs([...common, '--skip-session-id', 'session-active'])
    expect(activeSkipped.mode).toBe('dry-run')
    if (activeSkipped.mode !== 'dry-run') throw new Error('expected dry-run options')
    expect(activeSkipped.skippedSessionIds).toEqual(new Set(['session-active']))

    const complete = parseArgs([...common, '--confirm-quiesced'])
    expect(complete.mode).toBe('dry-run')
    if (complete.mode !== 'dry-run') throw new Error('expected dry-run options')
    expect(complete.skippedSessionIds).toEqual(new Set())

    expect(() => parseArgs([
      ...common,
      '--confirm-quiesced',
      '--skip-session-id', 'session-active',
    ])).toThrow('--confirm-quiesced cannot be combined with --skip-session-id')
  })

  it('dry-runs the complete catalog without touching artifacts', async () => {
    const workspace = await freshRoot()
    const root = join(workspace, 'sessions')
    const cwd = '/tmp/project'
    const eligible = await writeZstdLog(root, cwd, 'legacy', legacyHeader('legacy', cwd))
    await writeZstdLog(root, cwd, 'migrated', legacyHeader('migrated', cwd, { driverId: 'dsh' }))
    await writeZstdLog(root, cwd, 'foreign', legacyHeader('foreign', cwd, { version: 1 }))
    const active = await writeZstdLog(
      root,
      cwd,
      'session-a7760c07-8c6c-4fd4-b0d3-441e06d77e96',
      legacyHeader('session-a7760c07-8c6c-4fd4-b0d3-441e06d77e96', cwd),
    )
    const malformed = logPath(root, cwd, 'malformed' as never, 'zstd')
    await mkdir(dirname(malformed), { recursive: true })
    await writeFile(malformed, await compressZstdFrame('{not json}\n'))
    await writeZstdLog(
      root,
      cwd,
      'unknown-required-event',
      legacyHeader('unknown-required-event', cwd),
      JSON.stringify({ type: 'future/required', seq: 0, time: 2, data: {} }) + '\n',
    )
    const dryRunManifest = join(workspace, 'dry-run.json')

    const beforeEligible = await readFile(eligible.path)
    const beforeActive = await stat(active.path, { bigint: true })
    const result = await migrateLegacySessionDriverId({
      mode: 'dry-run',
      root,
      manifestPath: dryRunManifest,
      skippedSessionIds: new Set(['session-a7760c07-8c6c-4fd4-b0d3-441e06d77e96']),
    })

    expect(result.summary).toMatchObject({
      eligible: 1,
      'skipped-active': 1,
      'skipped-already-migrated': 1,
      'skipped-foreign-version': 1,
      'skipped-unsupported-event': 1,
      'skipped-malformed': 1,
    })
    expect(await readFile(eligible.path)).toEqual(beforeEligible)
    expect(await stat(active.path, { bigint: true })).toMatchObject({
      ino: beforeActive.ino,
      size: beforeActive.size,
      mtimeNs: beforeActive.mtimeNs,
      ctimeNs: beforeActive.ctimeNs,
    })
    expect(await readdir(dirname(eligible.path))).toEqual(['session.jsonl.zstd'])
    expect(JSON.parse(await readFile(dryRunManifest, 'utf8'))).toMatchObject({ mode: 'dry-run', planId: result.planId })
  })

  it('applies only a dry-run-bound candidate with a hard-link backup and byte-identical event frames', async () => {
    const workspace = await freshRoot()
    const root = join(workspace, 'sessions')
    const cwd = '/tmp/project'
    const fixture = await writeZstdLog(root, cwd, 'legacy', legacyHeader('legacy', cwd))
    const original = await readFile(fixture.path)
    const originalStat = await stat(fixture.path, { bigint: true })
    const dryRunManifest = join(workspace, 'dry-run.json')
    const applyManifest = join(workspace, 'apply.json')
    const dryRun = await migrateLegacySessionDriverId({
      mode: 'dry-run',
      root,
      manifestPath: dryRunManifest,
      skippedSessionIds: new Set(),
    })

    const applied = await migrateLegacySessionDriverId({
      mode: 'apply',
      manifestPath: applyManifest,
      dryRunManifestPath: dryRunManifest,
      confirmedQuiesced: true,
    })

    expect(applied.summary.migrated).toBe(1)
    const entry = applied.entries[0]!
    expect(entry.backupPath).toBe(`${fixture.path}.pre-driver-id-${dryRun.planId}.bak`)
    expect(await readFile(entry.backupPath!)).toEqual(original)
    const backupStat = await stat(entry.backupPath!, { bigint: true })
    expect(backupStat.ino).toBe(originalStat.ino)
    const migrated = await readFile(fixture.path)
    const { frames, tornStart } = scanZstdFrames(migrated)
    expect(tornStart).toBeUndefined()
    expect(migrated.subarray(frames[0]!.end)).toEqual(fixture.tail)
    expect(JSON.parse((await decompressZstdFrame(migrated.subarray(0, frames[0]!.end))).toString())).toEqual({
      type: 'session',
      version: 0,
      driverId: 'dsh',
      id: 'legacy',
      createdAt: 1,
      cwd,
      delegationDepth: 0,
    })
    const migratedStat = await stat(fixture.path, { bigint: true })
    expect(Number(migratedStat.mode & 0o7777n)).toBe(Number(originalStat.mode & 0o7777n))
    expect(migratedStat.mtimeMs).toBe(originalStat.mtimeMs)
  })

  it('rejects a dry-run manifest whose plan id could escape backup filenames', async () => {
    const workspace = await freshRoot()
    const root = join(workspace, 'sessions')
    const cwd = '/tmp/project'
    const fixture = await writeZstdLog(root, cwd, 'legacy', legacyHeader('legacy', cwd))
    const dryRunManifest = join(workspace, 'dry-run.json')
    await migrateLegacySessionDriverId({
      mode: 'dry-run',
      root,
      manifestPath: dryRunManifest,
      skippedSessionIds: new Set(),
    })
    const manifest = JSON.parse(await readFile(dryRunManifest, 'utf8')) as Record<string, unknown>
    manifest.planId = '../../escape'
    const tampered = join(workspace, 'tampered.json')
    await writeFile(tampered, JSON.stringify(manifest))

    await expect(migrateLegacySessionDriverId({
      mode: 'apply',
      manifestPath: join(workspace, 'apply.json'),
      dryRunManifestPath: tampered,
      confirmedQuiesced: true,
    })).rejects.toThrow('invalid plan, script digest, or candidate inventory')
    expect(await readdir(dirname(fixture.path))).toEqual(['session.jsonl.zstd'])
  })

  it('refuses apply when the source differs from the dry run', async () => {
    const workspace = await freshRoot()
    const root = join(workspace, 'sessions')
    const cwd = '/tmp/project'
    const fixture = await writeZstdLog(root, cwd, 'legacy', legacyHeader('legacy', cwd))
    const dryRunManifest = join(workspace, 'dry-run.json')
    await migrateLegacySessionDriverId({
      mode: 'dry-run',
      root,
      manifestPath: dryRunManifest,
      skippedSessionIds: new Set(),
    })
    await link(fixture.path, `${fixture.path}.unrelated-hard-link`)
    await writeFile(fixture.path, Buffer.concat([await readFile(fixture.path), await compressZstdFrame(eventRows(2, 2))]))

    const result = await migrateLegacySessionDriverId({
      mode: 'apply',
      manifestPath: join(workspace, 'apply.json'),
      dryRunManifestPath: dryRunManifest,
      confirmedQuiesced: true,
    })

    expect(result.summary['skipped-source-mismatch']).toBe(1)
    expect((await readdir(dirname(fixture.path))).some(name => name.includes('.pre-driver-id-'))).toBe(false)
  })
})
