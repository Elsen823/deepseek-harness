// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry, partitionBootRoster } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  document.body.innerHTML = ''
})

/** Install the stable facade shape that the Host injects before AppWebEntry runs. */
function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('renders a missing bootstrap facade', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap facade is missing',
    )
  })

  it('renders a create failure owned by the facade', async () => {
    await expectBootFailure(() => {
      installFacade(() => { throw new Error('facade create failed') })
    }, 'facade create failed')
  })

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installFacade()
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installFacade()
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = { rev: 'graph', entries: [duplicate, duplicate] }
    }, 'duplicate graph entry "duplicate"')
  })
})

describe('plugin activation', () => {
  it('allows a modules-dependent row to be created before the modules row', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const consumerId = '@deepseek-ai/dsh-client-ui-layout'
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const entries: WebBootEntry[] = [
      { id: consumerId, url: '/consumer.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/consumer.js', {
        id: consumerId,
        factory: () => ({
          inject: ['modules'],
          apply: (ctx: Context) => {
            expect(ctx.modules).toBeDefined()
            events.push('consumer')
          },
        }),
      }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()

    expect(target.mode).toBe('live')
    expect(events).toEqual(['consumer', 'mount'])
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })

  it('mounts after chrome entries and activates the rest afterwards', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const entries: WebBootEntry[] = [
      { id: 'heavy-plugin', url: '/heavy.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: layoutId, url: '/layout.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/heavy.js', {
        id: 'heavy-plugin',
        factory: () => ({
          apply: () => { events.push('heavy') },
        }),
      }],
      ['/layout.js', {
        id: layoutId,
        factory: () => ({
          apply: () => { events.push('layout') },
        }),
      }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    expect(events).toEqual(['layout', 'mount'])
    expect(container.textContent).toBe('mounted')
    await vi.waitFor(() => { expect(events).toEqual(['layout', 'mount', 'heavy']) })
    await entry.dispose()
  })

  it('waits for two animation frames after mount before activating deferred entries', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const entries: WebBootEntry[] = [
      { id: 'heavy-plugin', url: '/heavy.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: layoutId, url: '/layout.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/heavy.js', { id: 'heavy-plugin', factory: () => ({ apply: () => { events.push('heavy') } }) }],
      ['/layout.js', { id: layoutId, factory: () => ({ apply: () => { events.push('layout') } }) }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    expect(events).toEqual(['layout', 'mount'])
    expect(frames).toHaveLength(1)
    const first = frames.shift()
    if (first === undefined) throw new Error('missing first animation frame')
    first(0)
    await vi.waitFor(() => { expect(frames).toHaveLength(1) })
    expect(events).toEqual(['layout', 'mount'])
    const second = frames.shift()
    if (second === undefined) throw new Error('missing second animation frame')
    second(16)
    await vi.waitFor(() => { expect(events).toEqual(['layout', 'mount', 'heavy']) })
    await entry.dispose()
  })

  it('does not start deferred entries once disposal begins before first paint', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const loads: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const entries: WebBootEntry[] = [
      { id: 'heavy-plugin', url: '/heavy.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/heavy.js', { id: 'heavy-plugin', factory: () => ({ apply: () => {} }) }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: () => () => {},
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        loads.push(url)
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    expect(frames).toHaveLength(1)
    await entry.dispose()
    const first = frames[0]
    if (first === undefined) throw new Error('missing first animation frame')
    first(0)
    await Promise.resolve()
    expect(loads).not.toContain('/heavy.js')
  })

  it('waits for every deferred import to settle before disposal completes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const entries: WebBootEntry[] = [
      { id: 'failed-plugin', url: '/failed.js', rev: '1' },
      { id: 'slow-plugin', url: '/slow.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: layoutId, url: '/layout.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    let releaseSlow = (): void => {}
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/layout.js', {
        id: layoutId,
        factory: () => ({ apply: () => {} }),
      }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
      ['/slow.js', {
        id: 'slow-plugin',
        factory: () => ({ apply: () => { events.push('slow-applied') } }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url === '/failed.js') throw new Error('deferred import failed')
        if (url === '/slow.js') {
          events.push('slow-started')
          await slow
        }
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    await vi.waitFor(() => { expect(events).toContain('slow-started') })
    let disposed = false
    const disposing = entry.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      expect(disposed).toBe(false)
    } finally {
      releaseSlow()
      await disposing
    }
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a pending deferred entry without replacing the mounted UI', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const entries: WebBootEntry[] = [
      { id: 'pending-plugin', url: '/pending.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: layoutId, url: '/layout.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/pending.js', {
        id: 'pending-plugin',
        factory: () => ({ inject: ['missingDeferredService'], apply: () => {} }),
      }],
      ['/layout.js', {
        id: layoutId,
        factory: () => ({ apply: () => {} }),
      }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledOnce()
      expect(String(error.mock.calls[0]?.[0]))
        .toContain('pending-plugin: pending (waiting for service: missingDeferredService)')
    })
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })

  it('audits pending siblings even when another deferred import fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const entries: WebBootEntry[] = [
      { id: 'failed-plugin', url: '/failed.js', rev: '1' },
      { id: 'pending-plugin', url: '/pending.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: layoutId, url: '/layout.js', rev: '1' },
      { id: rendererId, url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/pending.js', {
        id: 'pending-plugin',
        factory: () => ({ inject: ['missingDeferredService'], apply: () => {} }),
      }],
      ['/layout.js', {
        id: layoutId,
        factory: () => ({ apply: () => {} }),
      }],
      ['/renderer.js', {
        id: rendererId,
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url === '/failed.js') throw new Error('deferred import failed')
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()
    await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce() })
    const logged = error.mock.calls[0]?.[0] as unknown
    expect(logged).toBeInstanceOf(AggregateError)
    if (!(logged instanceof AggregateError)) throw new Error('expected an aggregate deferred failure')
    const messages = logged.errors.map(String).join('\n')
    expect(messages).toContain('deferred import failed')
    expect(messages)
      .toContain('pending-plugin: pending (waiting for service: missingDeferredService)')
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })
})

describe('partitionBootRoster', () => {
  it('keeps transitive inject providers in the paint-blocking wave', () => {
    const ids = [
      'heavy-plugin',
      'base-provider',
      '@deepseek-ai/dsh-client-modules',
      'chrome-provider',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-renderer',
    ]
    const inject = new Map<string, readonly string[]>([
      ['@deepseek-ai/dsh-client-ui-layout', ['chrome-provider', 'absent-provider']],
      ['chrome-provider', ['base-provider']],
      ['base-provider', ['chrome-provider']],
      ['absent-provider', ['heavy-plugin']],
    ])

    expect(partitionBootRoster(ids, inject)).toEqual({
      blocking: [
        'base-provider',
        '@deepseek-ai/dsh-client-modules',
        'chrome-provider',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-renderer',
      ],
      deferred: ['heavy-plugin'],
    })
  })

  it('defers every non-roster id even when only one blocking id is present', () => {
    expect(partitionBootRoster(['@deepseek-ai/dsh-client-modules', 'consumer', 'renderer']))
      .toEqual({
        blocking: ['@deepseek-ai/dsh-client-modules'],
        deferred: ['consumer', 'renderer'],
      })
    expect(partitionBootRoster([
      'heavy-plugin',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-renderer',
    ])).toEqual({
      blocking: [
        '@deepseek-ai/dsh-client-modules',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-renderer',
      ],
      deferred: ['heavy-plugin'],
    })
  })
})
