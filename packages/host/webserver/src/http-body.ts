/**
 * Shared HTTP body writer for origin asset routes: gzip/Brotli negotiation,
 * validators, and a loopback check that treats reverse-proxied connections as
 * remote even when the socket is 127.0.0.1.
 * @module
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { brotliCompress as brotliCompressCb, gzip as gzipCb } from 'node:zlib'

const gzip = promisify(gzipCb)
const brotliCompress = promisify(brotliCompressCb)

/** Browser-cacheable forever: the URL already contains a content hash or `rev`. */
export const HTTP_CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'

/** Revalidate each time; pair with an ETag so a matching validator returns 304. */
export const HTTP_CACHE_REVALIDATE = 'no-cache'

/** Skip compression when the gzip/Brotli framing would dominate the payload. */
const MIN_COMPRESS_BYTES = 256

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const PROXY_HEADERS = new Set(['forwarded', 'via', 'x-real-ip'])

/** Options for {@link writeHttpBody}. */
export interface HttpBodyWrite {
  /** HTTP status. Defaults to 200. */
  status?: number
  /** Complete Content-Type, including charset when the owner already has one. */
  contentType: string
  /** Cache-Control value chosen by the route owner. */
  cacheControl: string
  /** Uncompressed payload. */
  body: string | Buffer
  /**
   * Drop trailing `sourceMappingURL` comments so a remote DevTools session
   * does not request `.map` artifacts. Direct loopback responses keep them.
   */
  stripSourceMappingURL?: boolean
}

/**
 * True only for a browser talking to this process on loopback with no proxy
 * hop: the TCP peer is loopback, `Host` is a loopback name, and no forwarding
 * headers are present. Tailscale Serve and other reverse proxies terminate on
 * 127.0.0.1 while carrying the public `Host` and `X-Forwarded-*`.
 * @param req - the inbound request.
 * @returns whether source maps and other loopback-only artifacts may be served.
 */
export function isDirectLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress
  if (addr === undefined || !LOOPBACK_ADDRESSES.has(addr)) return false
  const host = headerValue(req.headers.host)
  if (host === undefined || !LOOPBACK_HOSTS.has(hostnameOf(host))) return false
  for (const [name, value] of Object.entries(req.headers)) {
    if (!name.toLowerCase().startsWith('x-forwarded-') && !PROXY_HEADERS.has(name.toLowerCase())) continue
    if (headerValue(value) !== undefined) return false
  }
  return true
}

/**
 * Write one buffered GET/HEAD body: negotiate gzip/Brotli, emit ETag / 304,
 * and omit the body on HEAD.
 * @param req - inbound request (method, Accept-Encoding, If-None-Match).
 * @param res - the node:http response to write.
 * @param write - uncompressed body and headers from the route owner.
 */
export async function writeHttpBody(
  req: IncomingMessage,
  res: ServerResponse,
  write: HttpBodyWrite,
): Promise<void> {
  let payload = typeof write.body === 'string' ? Buffer.from(write.body) : write.body
  if (write.stripSourceMappingURL === true) {
    payload = stripSourceMappingURL(payload, write.contentType)
  }
  const compressible = isCompressible(write.contentType)
  const selection = negotiateEncoding(
    headerValue(req.headers['accept-encoding']),
    compressible,
    payload.length >= MIN_COMPRESS_BYTES,
  )
  if (selection === undefined) {
    const headers: OutgoingHttpHeaders = {
      'content-type': write.contentType,
      'cache-control': write.cacheControl,
      vary: 'Accept-Encoding',
    }
    res.writeHead(406, headers)
    res.end()
    return
  }
  let encoded = payload
  let contentEncoding: 'gzip' | 'br' | undefined
  if (selection.name === 'gzip') {
    const compressed = await gzip(payload)
    if (compressed.length < payload.length || selection.q > selection.identityQ) {
      encoded = compressed
      contentEncoding = 'gzip'
    }
  } else if (selection.name === 'br') {
    const compressed = await brotliCompress(payload)
    if (compressed.length < payload.length || selection.q > selection.identityQ) {
      encoded = compressed
      contentEncoding = 'br'
    }
  }
  const etag = `"${fingerprint(payload, contentEncoding)}"`
  const headers: OutgoingHttpHeaders = {
    'content-type': write.contentType,
    'cache-control': write.cacheControl,
    etag,
    vary: 'Accept-Encoding',
  }
  if (contentEncoding !== undefined) headers['content-encoding'] = contentEncoding
  const noneMatch = headerValue(req.headers['if-none-match'])
  if (noneMatch !== undefined && etagMatches(noneMatch, etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['content-length'] = encoded.length
  res.writeHead(write.status ?? 200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(encoded)
}

/**
 * @param header - a Host header, possibly with a port or IPv6 brackets.
 * @returns the hostname without port.
 */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(1, end)
  }
  const colon = host.indexOf(':')
  return colon === -1 || host.indexOf(':', colon + 1) !== -1 ? host : host.slice(0, colon)
}

/**
 * @param value - a node:http header that may be repeated.
 * @returns the joined value, or undefined when absent.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * @param header - raw Accept-Encoding, possibly empty.
 * @param canCompress - whether this media type has gzip/Brotli representations.
 * @param preferCompression - whether compression wins an equal-quality tie.
 * @returns the selected available representation, or undefined when all are forbidden.
 */
function negotiateEncoding(
  header: string | undefined,
  canCompress: boolean,
  preferCompression: boolean,
): { name: 'identity' | 'gzip' | 'br'; q: number; identityQ: number } | undefined {
  if (header === undefined || header.trim() === '') {
    return { name: 'identity', q: 1, identityQ: 1 }
  }
  const qualities = new Map<'identity' | 'gzip' | 'br' | '*', number>()
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';')
    const token = (rawName ?? '').trim().toLowerCase()
    if (token !== 'identity' && token !== 'gzip' && token !== 'br' && token !== '*') continue
    let q = 1
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq === -1) continue
      if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue
      q = Number(param.slice(eq + 1))
    }
    if (!Number.isFinite(q) || q < 0 || q > 1) continue
    qualities.set(token, Math.max(q, qualities.get(token) ?? -1))
  }
  const wildcardQ = qualities.get('*')
  const positiveQualities = [...qualities.values()].filter(q => q > 0)
  const implicitIdentityQ = wildcardQ === 0
    ? 0
    : (positiveQualities.length === 0 ? 1 : Math.min(...positiveQualities))
  const identityQ = qualities.get('identity') ?? implicitIdentityQ
  const qualityOf = (name: 'identity' | 'gzip' | 'br'): number => {
    if (name === 'identity') return identityQ
    return qualities.get(name) ?? wildcardQ ?? 0
  }
  const preference: Array<'identity' | 'gzip' | 'br'> = canCompress
    ? (preferCompression ? ['br', 'gzip', 'identity'] : ['identity', 'br', 'gzip'])
    : ['identity']
  let best: { name: 'identity' | 'gzip' | 'br'; q: number; identityQ: number } | undefined
  for (const name of preference) {
    const q = qualityOf(name)
    if (q <= 0 || (best !== undefined && q <= best.q)) continue
    best = { name, q, identityQ }
  }
  return best
}

/**
 * @param contentType - complete Content-Type.
 * @returns whether gzip/Brotli is useful for this media type.
 */
function isCompressible(contentType: string): boolean {
  const type = mediaType(contentType)
  return type.startsWith('text/')
    || type === 'application/javascript'
    || type === 'application/json'
    || type === 'application/manifest+json'
    || type === 'application/xml'
    || type === 'image/svg+xml'
    || type.endsWith('+json')
    || type.endsWith('+xml')
}

/**
 * @param body - uncompressed bytes after optional sourceMappingURL stripping.
 * @param encoding - selected Content-Encoding, if any.
 * @returns hex fingerprint used as the ETag payload.
 */
function fingerprint(body: Buffer, encoding: 'gzip' | 'br' | undefined): string {
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 16)
  return encoding === undefined ? hash : `${hash}-${encoding}`
}

/**
 * @param noneMatch - If-None-Match header.
 * @param etag - the strong ETag we would send, including quotes.
 * @returns whether any listed tag matches.
 */
function etagMatches(noneMatch: string, etag: string): boolean {
  if (noneMatch.trim() === '*') return true
  for (const raw of noneMatch.split(',')) {
    const tag = raw.trim().replace(/^W\//, '')
    if (tag === etag) return true
  }
  return false
}

/**
 * @param contentType - complete Content-Type.
 * @returns the type token without parameters, lowercased.
 */
function mediaType(contentType: string): string {
  const separator = contentType.indexOf(';')
  return (separator === -1 ? contentType : contentType.slice(0, separator)).trim().toLowerCase()
}

/**
 * @param body - JS or CSS bytes.
 * @param contentType - complete Content-Type.
 * @returns the same bytes, or JS/CSS with a trailing sourceMappingURL comment removed.
 */
function stripSourceMappingURL(body: Buffer, contentType: string): Buffer {
  const type = mediaType(contentType)
  const js = type === 'text/javascript' || type === 'application/javascript'
  const css = type === 'text/css'
  if (!js && !css) return body
  const text = body.toString('utf8')
  const stripped = js
    ? text.replace(/(^|\n)[ \t]*\/\/# sourceMappingURL=[^\s`'"]+[ \t\r\n]*$/u, '$1')
    : text.replace(/(^|\n)[ \t]*\/\*# sourceMappingURL=[^\s*]+[ \t]*\*\/[ \t\r\n]*$/u, '$1')
  return stripped === text ? body : Buffer.from(stripped)
}
