/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and a two-row cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}\n//# sourceMappingURL=app.js.map\n')
  await writeFile(join(dist, 'app.js.map'), '{"version":3}\n')
  await writeFile(join(dist, 'app.js.MAP'), '{"version":3}\n')
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'assets', 'index-AAAAAAAA.js'), `${'export const shell = 1; '.repeat(40)}\n`)
  await writeFile(join(dist, 'assets', 'plain.js'), 'export const plain = true\n')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  await mkdir(join(dist, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{
  status: number
  type: string | null
  cache: string | null
  body: string
}> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
    body: (await response.text()).slice(0, 80),
  }
}

/** GET one path without automatic decompression so Content-Encoding is observable. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{
  status: number
  encoding: string | undefined
  cache: string | undefined
  body: Buffer
}> {
  return new Promise((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          encoding: response.headers['content-encoding'],
          cache: response.headers['cache-control'],
          body: Buffer.concat(chunks),
        })
      })
    }).on('error', reject).end()
  })
}

describe('real Loader composition', () => {
  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port

    // Real assets with their MIME types; a live rebuild is served on the next read.
    const appJs = await request(port, '/app.js')
    expect(appJs).toMatchObject({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      cache: 'no-cache',
    })
    expect(appJs.body).toContain('export {}')
    expect(appJs.body).toContain('sourceMappingURL')
    expect(await request(port, '/')).toMatchObject({ status: 200, cache: 'no-cache' })
    expect(await request(port, '/assets/index-AAAAAAAA.js')).toMatchObject({
      status: 200,
      cache: 'public, max-age=31536000, immutable',
    })
    expect(await request(port, '/assets/plain.js')).toMatchObject({ status: 200, cache: 'no-cache' })
    expect(await request(port, '/assets/%2e%2e%2fapp.js')).toMatchObject({ status: 200, cache: 'no-cache' })
    expect(await request(port, '/app.js.map')).toMatchObject({ status: 200, type: 'application/json' })
    expect(await request(port, '/app.js.map', { headers: { 'x-forwarded-for': '1.1.1.1' } }))
      .toMatchObject({ status: 404 })
    expect(await request(port, '/app.js.MAP')).toMatchObject({ status: 200 })
    expect(await request(port, '/app.js.MAP', { headers: { 'x-forwarded-for': '1.1.1.1' } }))
      .toMatchObject({ status: 404 })
    const gzipped = await rawGet(port, '/assets/index-AAAAAAAA.js', { 'accept-encoding': 'gzip' })
    expect(gzipped.status).toBe(200)
    expect(gzipped.encoding).toBe('gzip')
    expect(gunzipSync(gzipped.body).toString('utf8')).toContain('export const shell')
    const forwardedJs = await rawGet(port, '/app.js', {
      'accept-encoding': 'identity',
      'x-forwarded-for': '1.1.1.1',
    })
    expect(forwardedJs.body.toString('utf8')).toBe('export {}\n')
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    expect(await request(port, '/app.js', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      cache: 'no-cache',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    for (const path of ['/', '/index.html', '/?fixture']) {
      const got = await request(port, path)
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
    }
    expect(await request(port, '/', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      cache: 'no-cache',
      body: '',
    })
    untap()
    expect((await request(port, '/')).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, cache: null, body: '' })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell.
    const ordinaryMisses = ['/no/such/route', '/api/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, cache: null, body: '' })
      expect(head).toEqual(get)
    }

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })
})
