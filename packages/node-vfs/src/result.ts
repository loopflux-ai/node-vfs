/** Result constructors + deep-freeze for shared result/meta references. */

import type { OkResult } from './types.ts'

/** Recursively freeze an object. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object')
    return value
  if (Object.isFrozen(value))
    return value
  if (seen.has(value as object))
    return value
  seen.add(value as object)
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v, seen)
  }
  return Object.freeze(value)
}

export function ok<T, M = Record<string, unknown>>(
  data: T,
  meta: M,
  tokens: number,
): OkResult<T, M> {
  return { ok: true, data, meta, tokens }
}
