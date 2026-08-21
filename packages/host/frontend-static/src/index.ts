/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index entry
 * points. A readable index renders at the dist root and configured index path;
 * missing paths return 404, traversal outside the dist root is 403, unknown
 * extensions ship as octet-stream, and non-GET/HEAD is 405. Hashed `/assets/`
 * files are immutable; index and other unhashed files revalidate. gzip/Brotli
 * are negotiated when Accept-Encoding permits a useful representation. Source
 * maps are omitted unless the request is direct loopback. Every index response
 * runs through the webserver's
 * index render (structured injection rows, then raw taps). The dist location is
 * workspace knowledge of the composing application, so `distIndex` is typically
 * supplied through a `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  HTTP_CACHE_IMMUTABLE,
  HTTP_CACHE_REVALIDATE,
  isDirectLoopback,
  writeHttpBody,
} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Service required before the fallback seat can be claimed. */
export const inject = ['webServer']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'
const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** Vite-style content hash immediately before the final extension. */
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[^.]+$/u

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param req - inbound request (encoding, validators, loopback check).
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  req: IncomingMessage,
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const directLoopback = isDirectLoopback(req)
  if (extname(target).toLowerCase() === '.map' && !directLoopback) {
    res.writeHead(404)
    res.end()
    return
  }
  let body: string | Buffer
  let contentType: string
  let cacheControl: string
  let stripSourceMappingURL = false
  try {
    if (target === distRoot || target === distIndex) {
      body = await renderIndex()
      contentType = HTML_MIME
      cacheControl = HTTP_CACHE_REVALIDATE
    } else {
      body = await readFile(target)
      contentType = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      const targetFromRoot = relative(distRoot, target)
      const hashedAsset = targetFromRoot.split(sep)[0] === 'assets'
        && HASHED_ASSET_NAME.test(basename(target))
      cacheControl = hashedAsset ? HTTP_CACHE_IMMUTABLE : HTTP_CACHE_REVALIDATE
      stripSourceMappingURL = !directLoopback
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  await writeHttpBody(req, res, {
    contentType,
    cacheControl,
    body,
    stripSourceMappingURL,
  })
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(req, decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex)
  }), 'frontend-static: fallback seat')
}
