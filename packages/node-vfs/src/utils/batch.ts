/**
 * Batch concurrency — `processInBatches` wraps p-limit with abort + OOM guard.
 * On abort: clears queue and rejects immediately (avoids hanging Promise.all).
 */

import pLimit from 'p-limit'
import { NEVER_ABORT, throwIfAborted } from './signal.ts'

/** Hard cap for input length (prevents OOM). */
export const MAX_BATCH_ITEMS = 50_000

/** Sliding-window worker pool with abort support. */
export function processInBatches<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal: AbortSignal = NEVER_ABORT,
): Promise<void> {
  if (items.length === 0)
    return Promise.resolve()
  if (concurrency <= 0)
    concurrency = 1

  if (items.length > MAX_BATCH_ITEMS) {
    return Promise.reject(
      new RangeError(
        `processInBatches: ${items.length} items exceeds the maximum of ${MAX_BATCH_ITEMS} (chunk or filter the input)`,
      ),
    )
  }

  const limit = pLimit(concurrency)

  // Abort clears queue + rejects immediately so callers never hang.
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const onAbort = (): void => {
      if (settled)
        return
      settled = true
      limit.clearQueue()
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Aborted'))
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    Promise.all(
      items.map((item, i) =>
        limit(async () => {
          if (settled)
            return
          throwIfAborted(signal)
          await worker(item, i)
        }),
      ),
    )
      .then(() => {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
      .catch((e: unknown) => {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(e)
      })
  })
}

/** Wrap an array as an async iterable. */
export async function* arrayToAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items)
    yield item
}
