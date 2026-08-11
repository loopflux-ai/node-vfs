/**
 * AbortSignal helpers. `combineSignals` aborts when either source aborts;
 * `__cleanupCombineSignals` hook prevents listener accumulation.
 */

/** Signal that never aborts. */
const NEVER_ABORT_CONTROLLER = new AbortController()
export const NEVER_ABORT: AbortSignal = NEVER_ABORT_CONTROLLER.signal

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason
    if (reason instanceof Error)
      throw reason
    throw new Error('Aborted')
  }
}

/** Combine two signals — derived aborts when either source aborts. */
export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a)
    return b ?? NEVER_ABORT
  if (!b)
    return a
  if (a.aborted || b.aborted)
    return a.aborted ? a : b
  const controller = new AbortController()
  const onAbortA = (): void => controller.abort(a.reason)
  const onAbortB = (): void => controller.abort(b.reason)
  a.addEventListener('abort', onAbortA, { once: true })
  b.addEventListener('abort', onAbortB, { once: true })
  // Re-check after listener registration (race guard).
  if (a.aborted) {
    controller.abort(a.reason)
    a.removeEventListener('abort', onAbortA)
    b.removeEventListener('abort', onAbortB)
    return a
  }
  if (b.aborted) {
    controller.abort(b.reason)
    a.removeEventListener('abort', onAbortA)
    b.removeEventListener('abort', onAbortB)
    return b
  }
  const derived = controller.signal
  ;(derived as AbortSignal & { __cleanupCombineSignals?: () => void }).__cleanupCombineSignals = () => {
    a.removeEventListener('abort', onAbortA)
    b.removeEventListener('abort', onAbortB)
  }
  return derived
}
