/**
 * Default debugger — outputs structured lines to stderr.
 *
 * Categories are stable contract surface — callers MUST reference
 * DEBUG_CATEGORY constants instead of string literals so typos are caught
 * at compile time and downstream log filters can rely on them.
 *
 * Production note: debug output may include sandbox-internal paths (e.g.
 * cache keys, affected paths). When enabling `debug: true` in production,
 * ensure stderr is not forwarded to log aggregation systems that should
 * not see sandbox internals, or inject a custom `debugger` that redacts
 * paths.
 */
import process from 'node:process'

/**
 * Stable category constants for VFSDebugger.debug() calls.
 *
 * Callers MUST reference these constants instead of inline string literals —
 * the values are a contract surface for downstream log filters.
 */
export const DEBUG_CATEGORY = {
  /** VFS op lifecycle. Message carries `${kind}` / `${kind} ok` / `${kind} error`. */
  OP: 'op',
  /** Cache hit (lookup found a live entry). */
  CACHE_HIT: 'cache.hit',
  /** Cache miss (cold or expired). Message distinguishes 'Cache miss' vs 'Cache miss (expired)'. */
  CACHE_MISS: 'cache.miss',
  /** Cache invalidation triggered by a command op. */
  CACHE_INVALIDATE: 'cache.invalidate',
} as const

export type DebugCategory = (typeof DEBUG_CATEGORY)[keyof typeof DEBUG_CATEGORY]

export interface VFSDebugger {
  debug: (category: string, message: string, meta?: Record<string, unknown>) => void
}

export function createDefaultDebugger(prefix: string): VFSDebugger {
  return {
    debug(category: string, message: string, meta?: Record<string, unknown>) {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
      process.stderr.write(`[${prefix}:${category}] ${message}${metaStr}\n`)
    },
  }
}
