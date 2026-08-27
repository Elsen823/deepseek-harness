/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

/** Maximum grace allowed for the application tree to dispose before process exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join graceful disposal before allowing natural completion with `code`. */
  shutdown(code: number): Promise<void>
  /**
   * Run the explicit restart-handoff barrier, then dispose the application.
   * A refused handoff rejects and leaves the application serving; it never
   * falls through to ordinary disposal.
   */
  restart(code?: number): Promise<void>
  /** Start graceful disposal followed by exit, or force exit when shutdown is already running. */
  interrupt(code: number): void
}

/**
 * Create one process-exit controller around an application disposer.
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @param forceExit - Function that exits the process immediately, replaceable by tests.
 * @param complete - Function that records the natural completion code, replaceable by tests.
 * @param timeoutMs - Grace before forced exit, replaceable by tests.
 * @param handoff - Explicit restart barrier; omitted when this surface cannot restart safely.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => { process.exit(code) },
  complete: (code: number) => void = (code) => { process.exitCode = code },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
  handoff?: () => Promise<void>,
): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forceExited = false

  const clearExitTimeout = (): void => {
    /* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
    if (timeout !== undefined) clearTimeout(timeout)
  }

  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    clearExitTimeout()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return
    completed = true
    clearExitTimeout()
    complete(code)
  }

  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => { forceExitOnce(code) }, timeoutMs)
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceExitOnce(code)
        else completeOnce(code)
      },
      () => { forceExitOnce(code) },
    )
    return pending
  }

  const restart = (code: number): Promise<void> => {
    if (pending !== undefined) return pending
    if (handoff === undefined) return Promise.reject(new Error('restart handoff is not configured'))
    // The handoff owns its bounded quiescence deadline. Do not arm the
    // ordinary disposal timeout until that barrier commits: a refused handoff
    // must keep the old generation serving and must not be force-exited.
    const requested = Promise.resolve().then(handoff)
    // Resolve the caller as soon as the handoff is durably accepted. The
    // host.restart RPC must serialize that accepted response before the root
    // fiber starts disposing the HTTP carrier; scheduling the ordinary stop
    // for the next event-loop turn gives the carrier one complete response
    // turn while retaining the normal bounded disposal path.
    const accepted = requested.then(
      () => {
        pending = undefined
        setImmediate(() => {
          pending = start(code, false)
          void pending.catch(() => undefined)
        })
      },
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    pending = accepted
    return accepted
  }

  return {
    shutdown(code) {
      return start(code, false)
    },
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code)
        return
      }
      void start(code, true)
    },
    restart(code = 0) {
      return restart(code)
    },
  }
}
