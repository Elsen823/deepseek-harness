import { randomBytes } from 'node:crypto'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  HTTP_CACHE_IMMUTABLE,
  HTTP_CACHE_REVALIDATE,
  isDirectLoopback,
  writeHttpBody,
} from '../src/http-body.ts'

const TEXT = `${'page-load-asset '.repeat(40)}\n`

class CaptureResponse {
  status = 0
  headers: OutgoingHttpHeaders = {}
  chunks: Buffer[] = []

  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    this.status = status
    this.headers = { ...headers }
    return this
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return this
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function request(partial: {
  method?: string
  url?: string
  headers?: IncomingMessage['headers']
  remoteAddress?: string
}): IncomingMessage {
  return {
    method: partial.method ?? 'GET',
    url: partial.url ?? '/',
    headers: partial.headers ?? { host: '127.0.0.1:1' },
    socket: { remoteAddress: partial.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage
}

describe('isDirectLoopback', () => {
  it('accepts a loopback TCP peer with a loopback Host', () => {
    expect(isDirectLoopback(request({}))).toBe(true)
    expect(isDirectLoopback(request({ remoteAddress: '::1', headers: { host: '[::1]:3081' } }))).toBe(true)
    expect(isDirectLoopback(request({
      remoteAddress: '::ffff:127.0.0.1',
      headers: { host: 'localhost:3081' },
    }))).toBe(true)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1' } }))).toBe(true)
  })

  it('rejects missing Host, missing sockets, non-loopback peers, public Host, and forwarded hops', () => {
    expect(isDirectLoopback(request({ headers: {} }))).toBe(false)
    expect(isDirectLoopback(request({ remoteAddress: '' }))).toBe(false)
    expect(isDirectLoopback(request({ remoteAddress: '100.72.27.29' }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: 'elsen-vm.tail8b4e1b.ts.net:8443' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-forwarded-for': '1.1.1.1' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-forwarded-proto': 'https' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-forwarded-host': 'public.example' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-forwarded-port': '443' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-forwarded-custom': '' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', 'x-real-ip': '1.1.1.1' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', forwarded: 'for=1.1.1.1' } }))).toBe(false)
    expect(isDirectLoopback(request({ headers: { host: '127.0.0.1:1', via: '1.1 proxy.example' } }))).toBe(false)
    expect(isDirectLoopback(request({
      headers: { host: '127.0.0.1:1', 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] },
    }))).toBe(false)
  })

  it('treats an unbracketed multi-colon Host as the whole hostname', () => {
    expect(isDirectLoopback(request({
      remoteAddress: '::1',
      headers: { host: 'fe80::1' },
    }))).toBe(false)
  })

  it('treats a truncated IPv6 Host as non-loopback', () => {
    expect(isDirectLoopback(request({
      remoteAddress: '::1',
      headers: { host: '[::1' },
    }))).toBe(false)
  })
})

describe('writeHttpBody', () => {
  it('gzips compressible text and answers 304 for a matching validator', async () => {
    const first = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip' } }), first as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(first.status).toBe(200)
    expect(first.headers['content-encoding']).toBe('gzip')
    expect(first.headers.vary).toBe('Accept-Encoding')
    expect(first.headers['cache-control']).toBe(HTTP_CACHE_IMMUTABLE)
    expect(gunzipSync(first.body()).toString('utf8')).toBe(TEXT)
    const etag = first.headers.etag
    expect(etag).toEqual(expect.stringMatching(/^"[0-9a-f]+-gzip"$/))

    const again = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(etag) },
    }), again as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(again.status).toBe(304)
    expect(again.body().length).toBe(0)
  })

  it('prefers Brotli at equal quality and honors q=0 / identity', async () => {
    const br = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip, br' },
    }), br as unknown as ServerResponse, {
      contentType: 'text/css; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(br.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(br.body()).toString('utf8')).toBe(TEXT)

    const gzipWins = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'br;q=0.1, gzip;q=0.9' },
    }), gzipWins as unknown as ServerResponse, {
      contentType: 'text/html; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(gzipWins.headers['content-encoding']).toBe('gzip')

    const none = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip;q=0, br;q=0, deflate' },
    }), none as unknown as ServerResponse, {
      contentType: 'application/json',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(none.headers['content-encoding']).toBeUndefined()
    expect(none.body().toString('utf8')).toBe(TEXT)

    const star = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': '*;q=0.5' },
    }), star as unknown as ServerResponse, {
      contentType: 'application/manifest+json',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(star.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(star.body()).toString('utf8')).toBe(TEXT)

    const empty = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': '  ' },
    }), empty as unknown as ServerResponse, {
      contentType: 'image/svg+xml',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(empty.headers['content-encoding']).toBeUndefined()
  })

  it('honors explicit identity quality and coding exclusions before wildcard matches', async () => {
    const identity = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'identity;q=1, br;q=.5' },
    }), identity as unknown as ServerResponse, {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(identity.status).toBe(200)
    expect(identity.headers['content-encoding']).toBeUndefined()
    expect(identity.body().toString('utf8')).toBe(TEXT)

    const wildcard = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip;q=0, *;q=.5' },
    }), wildcard as unknown as ServerResponse, {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(wildcard.status).toBe(200)
    expect(wildcard.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(wildcard.body()).toString('utf8')).toBe(TEXT)
  })

  it('answers 406 when every available representation is forbidden', async () => {
    const response = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'identity;q=0, gzip;q=0, br;q=0, *;q=0' },
    }), response as unknown as ServerResponse, {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(response.status).toBe(406)
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.body().length).toBe(0)
  })

  it('skips compression for small, incompressible, or already-binary bodies', async () => {
    const tiny = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip, br' } }), tiny as unknown as ServerResponse, {
      contentType: 'text/plain',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: 'tiny',
    })
    expect(tiny.headers['content-encoding']).toBeUndefined()
    expect(tiny.body().toString('utf8')).toBe('tiny')

    const binary = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip' } }), binary as unknown as ServerResponse, {
      contentType: 'application/octet-stream',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(binary.headers['content-encoding']).toBeUndefined()
    expect(binary.headers.vary).toBe('Accept-Encoding')

    const forbiddenBinary = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'identity;q=0, *;q=0' },
    }), forbiddenBinary as unknown as ServerResponse, {
      contentType: 'application/octet-stream',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(forbiddenBinary.status).toBe(406)
    expect(forbiddenBinary.headers.vary).toBe('Accept-Encoding')
    expect(forbiddenBinary.body().length).toBe(0)

    const random = new CaptureResponse()
    const noise = gzipSync(randomBytes(2000))
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip, br' } }), random as unknown as ServerResponse, {
      contentType: 'text/plain',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: noise,
    })
    expect(random.headers['content-encoding']).toBeUndefined()
    expect(random.body().equals(noise)).toBe(true)
  })

  it('strips trailing sourceMappingURL comments from JS and CSS only', async () => {
    const js = new CaptureResponse()
    await writeHttpBody(request({}), js as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: 'export {}\n//# sourceMappingURL=app.js.map\n',
      stripSourceMappingURL: true,
    })
    expect(js.body().toString('utf8')).toBe('export {}\n')

    const css = new CaptureResponse()
    await writeHttpBody(request({}), css as unknown as ServerResponse, {
      contentType: 'text/css',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: 'body{}\n/*# sourceMappingURL=app.css.map */\n',
      stripSourceMappingURL: true,
    })
    expect(css.body().toString('utf8')).toBe('body{}\n')

    const jsOnlyComment = new CaptureResponse()
    await writeHttpBody(request({}), jsOnlyComment as unknown as ServerResponse, {
      contentType: 'text/javascript',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: '//# sourceMappingURL=app.js.map\n',
      stripSourceMappingURL: true,
    })
    expect(jsOnlyComment.body().toString('utf8')).toBe('')

    const cssOnlyComment = new CaptureResponse()
    await writeHttpBody(request({}), cssOnlyComment as unknown as ServerResponse, {
      contentType: 'text/css',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: '/*# sourceMappingURL=app.css.map */\n',
      stripSourceMappingURL: true,
    })
    expect(cssOnlyComment.body().toString('utf8')).toBe('')

    const json = new CaptureResponse()
    await writeHttpBody(request({}), json as unknown as ServerResponse, {
      contentType: 'application/json',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: '{}\n//# sourceMappingURL=x.map\n',
      stripSourceMappingURL: true,
    })
    expect(json.body().toString('utf8')).toBe('{}\n//# sourceMappingURL=x.map\n')

    const untouched = new CaptureResponse()
    await writeHttpBody(request({}), untouched as unknown as ServerResponse, {
      contentType: 'application/javascript',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: 'export {}\n',
      stripSourceMappingURL: true,
    })
    expect(untouched.body().toString('utf8')).toBe('export {}\n')

    const templateSource = 'const value = `line one\n//# sourceMappingURL=ordinary-template-text`\n'
    const template = new CaptureResponse()
    await writeHttpBody(request({}), template as unknown as ServerResponse, {
      contentType: 'application/javascript',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: templateSource,
      stripSourceMappingURL: true,
    })
    expect(template.body().toString('utf8')).toBe(templateSource)
  })

  it('omits the body on HEAD and honors weak or wildcard validators', async () => {
    const head = new CaptureResponse()
    await writeHttpBody(request({ method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }), head as unknown as ServerResponse, {
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(head.status).toBe(200)
    expect(head.headers['content-encoding']).toBe('gzip')
    expect(head.body().length).toBe(0)
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)

    const probe = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip' } }), probe as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    const etag = String(probe.headers.etag)
    const weak = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip', 'if-none-match': `W/${etag}, "other"` },
    }), weak as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(weak.status).toBe(304)

    const star = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip', 'if-none-match': ' * ' },
    }), star as unknown as ServerResponse, {
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: HTTP_CACHE_IMMUTABLE,
      body: TEXT,
    })
    expect(star.status).toBe(304)

    const miss = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip', 'if-none-match': '"nope"' },
    }), miss as unknown as ServerResponse, {
      contentType: 'application/xml',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(miss.status).toBe(200)
  })

  it('ignores malformed quality values and unknown parameters', async () => {
    const nan = new CaptureResponse()
    await writeHttpBody(request({
      headers: { 'accept-encoding': 'gzip;q=not-a-number, br;q=0, gzip;foo, gzip;q=1' },
    }), nan as unknown as ServerResponse, {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(nan.headers['content-encoding']).toBe('gzip')
  })

  it('compresses +json and +xml types', async () => {
    const plus = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip' } }), plus as unknown as ServerResponse, {
      contentType: 'application/feed+json',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(plus.headers['content-encoding']).toBe('gzip')

    const xml = new CaptureResponse()
    await writeHttpBody(request({ headers: { 'accept-encoding': 'gzip' } }), xml as unknown as ServerResponse, {
      contentType: 'application/atom+xml',
      cacheControl: HTTP_CACHE_REVALIDATE,
      body: TEXT,
    })
    expect(xml.headers['content-encoding']).toBe('gzip')
  })
})
