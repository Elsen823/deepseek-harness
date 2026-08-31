/** Root `.gitignore` keeps local residue and vendor `src` emit out of `git add -A`. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const gitignoreText = readFileSync(join(repositoryRoot, '.gitignore'), 'utf8')
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function checkIgnore(cwd: string, path: string): { status: number; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'check-ignore', '-v', '--', path], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  return { status: result.status ?? 1, stdout: result.stdout }
}

function initFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gitignore-'))
  fixtures.push(root)
  git(root, ['init', '--initial-branch=main'])
  writeFileSync(join(root, '.gitignore'), gitignoreText)
  mkdirSync(join(root, 'agent-hooks/relay.sock'), { recursive: true })
  writeFileSync(join(root, 'agent-hooks/relay.sock/endpoint.env'), 'ORCA_AGENT_HOOK_TOKEN=fixture\n')
  mkdirSync(join(root, '.scratch/agent-driver-integration'), { recursive: true })
  writeFileSync(join(root, '.scratch/agent-driver-integration/note.md'), 'scratch\n')
  mkdirSync(join(root, '.agent-teams'), { recursive: true })
  writeFileSync(join(root, '.agent-teams/retired-members.json'), '[]\n')
  writeFileSync(join(root, 'CONTEXT.md'), 'glossary\n')
  mkdirSync(join(root, 'vendor/group/src'), { recursive: true })
  writeFileSync(join(root, 'vendor/group/src/index.js'), 'export {}\n')
  writeFileSync(join(root, 'vendor/group/src/index.js.map'), '{}\n')
  writeFileSync(join(root, 'vendor/group/src/index.d.ts'), 'export {}\n')
  writeFileSync(join(root, 'vendor/group/src/index.d.ts.map'), '{}\n')
  writeFileSync(join(root, 'vendor/group/src/index.ts'), 'export {}\n')
  writeFileSync(join(root, 'keep-me.txt'), 'tracked-candidate\n')
  return root
}

describe('root gitignore local residue', () => {
  it('leaves hook credentials, scratch, teams, CONTEXT.md, and vendor src emit unstaged after git add -A', () => {
    const root = initFixture()
    git(root, ['add', '-A'])
    const staged = git(root, ['diff', '--cached', '--name-only'])
      .split('\n')
      .filter(path => path.length > 0)
      .sort()
    expect(staged).toEqual(['.gitignore', 'keep-me.txt', 'vendor/group/src/index.ts'])
  })

  it('matches residue paths with check-ignore and does not ignore vendor src TypeScript', () => {
    const root = initFixture()
    const ignored = [
      'agent-hooks/relay.sock/endpoint.env',
      '.scratch/agent-driver-integration/note.md',
      '.agent-teams/retired-members.json',
      'CONTEXT.md',
      'vendor/group/src/index.js',
      'vendor/group/src/index.d.ts',
      'vendor/group/src/index.js.map',
      'vendor/group/src/index.d.ts.map',
    ]
    for (const path of ignored) {
      const result = checkIgnore(root, path)
      expect(result.status, path).toBe(0)
      expect(result.stdout.length, path).toBeGreaterThan(0)
    }
    const source = checkIgnore(root, 'vendor/group/src/index.ts')
    expect(source.status).toBe(1)
  })
})
