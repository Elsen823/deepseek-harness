/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after paint-blocking chrome entries activate; remaining graph rows
 * load after first paint.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/**
 * Graph rows that must reach ACTIVE before `uiRenderer.mount`. Workspace
 * chrome lives here; settings, trajectory, and third-party client plugins
 * activate after first paint.
 */
const PAINT_BLOCKING_IDS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  'dsh-web-auth',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-brand-official',
])

/**
 * Split a boot graph into the paint-blocking roster and the rest.
 * @param ids - loader entry names in graph order.
 * @param inject - package dependency edges keyed by loader entry name.
 * @returns blocking ids created before mount, and deferred ids created after.
 */
export function partitionBootRoster(
  ids: readonly string[],
  inject: ReadonlyMap<string, readonly string[]> = new Map(),
): {
  blocking: string[]
  deferred: string[]
} {
  const blockingIds = new Set(ids.filter(id => PAINT_BLOCKING_IDS.has(id)))
  const knownIds = new Set(ids)
  const pending = [...blockingIds]
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]
    if (id === undefined) break
    for (const dependency of inject.get(id) ?? []) {
      if (!knownIds.has(dependency) || blockingIds.has(dependency)) continue
      blockingIds.add(dependency)
      pending.push(dependency)
    }
  }
  return {
    blocking: ids.filter(id => blockingIds.has(id)),
    deferred: ids.filter(id => !blockingIds.has(id)),
  }
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private deferredIds: string[] = []
  private deferredActivation: Promise<void> | undefined
  private cancelAfterPaint: (() => void) | undefined

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
      this.deferredActivation = this.activateDeferredAfterPaint(ctx)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    this.cancelAfterPaint?.()
    this.page.dispose()
    await this.deferredActivation?.catch(() => {
      // Deferred activation is best-effort after first paint; disposal owns the tree.
    })
    if (ctx !== undefined) await ctx.fiber.dispose()
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(): Promise<void> {
    // A transport carrying loadBundle owns the bundle bytes; HTTP prefetch
    // against its static deployment answers nothing. A transport without
    // loadBundle leaves bundles on HTTP, prefetch included.
    const transport = (globalThis as {
      __DSH_TRANSPORT__?: { loadBundle?: unknown }
    }).__DSH_TRANSPORT__
    if (transport?.loadBundle !== undefined) return
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = this.modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = this.manifest.plugins
    const ids = rows.map(row => row.id)
    const inject = new Map(rows.map(row => [row.id, row.inject] as const))
    const { blocking, deferred } = partitionBootRoster(ids, inject)
    this.deferredIds = deferred
    this.page.setTotal(blocking.length)
    await prefetching
    await this.createEntries(loader, blocking, true)
    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /**
   * Create loader entries and optionally project their states onto the boot page.
   * @param loader - the client Loader after `internal` is installed.
   * @param names - entry names to create.
   * @param report - whether to update the boot page.
   */
  private async createEntries(
    loader: Context['loader'],
    names: readonly string[],
    report: boolean,
  ): Promise<void> {
    const results = await Promise.allSettled(names.map(async (name) => {
      if (report) this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (report && loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'web boot: multiple entries failed to load')
    }
  }

  /**
   * Wait two frames so chrome paints before deferred work starts. Disposal
   * resolves this wait immediately, even when a background tab suppresses frames.
   * @returns whether both frames completed before disposal.
   */
  private waitForFirstPaint(): Promise<boolean> {
    const schedule = (callback: () => void): void => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback)
        return
      }
      setTimeout(callback, 0)
    }
    return new Promise((resolve) => {
      let settled = false
      let cancel: () => void = () => {}
      const settle = (painted: boolean): void => {
        if (settled) return
        settled = true
        if (this.cancelAfterPaint === cancel) this.cancelAfterPaint = undefined
        resolve(painted)
      }
      cancel = () => { settle(false) }
      this.cancelAfterPaint = cancel
      schedule(() => {
        if (settled) return
        schedule(() => { settle(true) })
      })
    })
  }

  /**
   * Wait until chrome has painted, then activate remaining graph rows only
   * while this entry still owns the client context.
   * @param ctx - the boot context that owns the loader.
   */
  private async activateDeferredAfterPaint(ctx: Context): Promise<void> {
    const painted = await this.waitForFirstPaint()
    if (!painted || this.ctx !== ctx) return
    await this.activateDeferred(ctx)
  }

  /**
   * Activate non-chrome graph rows after first paint. Failures log; they must
   * not replace the mounted UI with the boot error page.
   * @param ctx - the same boot context that owns the loader.
   */
  private async activateDeferred(ctx: Context): Promise<void> {
    const names = this.deferredIds
    if (names.length === 0) return
    try {
      const failures: unknown[] = []
      try {
        await this.createEntries(ctx.loader, names, false)
      } catch (error) {
        failures.push(error)
      }
      try {
        await ctx.loader.await()
      } catch (error) {
        failures.push(error)
      }
      try {
        this.assertEntriesActive(ctx)
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, 'web boot: deferred entries failed to activate')
      }
    } catch (error) {
      if (this.ctx !== ctx) return
      console.error(error)
    }
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
