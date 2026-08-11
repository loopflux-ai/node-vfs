/** Serial per-key mutex — concurrent callers on same key await previous completion. */

export async function withMutex<T>(
  locks: Map<string, Promise<unknown>>,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  // Chain for accurate cleanup.
  const chained = prev.then(() => next)
  locks.set(path, chained)
  try {
    await prev
    return await fn()
  }
  finally {
    release()
    if (locks.get(path) === chained) {
      locks.delete(path)
    }
  }
}
