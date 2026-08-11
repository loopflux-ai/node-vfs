/**
 * Shared test utilities — single source of truth for ctx construction,
 * stream draining, and narrowable Result assertions.
 *
 * `expectOkResult` / `expectErrResult` are the ONLY sanctioned way to unpack a
 * Result in tests. Asserting inside `if (result.ok)` blocks silently passes
 * when the result is an error (the assertions never run).
 */
import type { ErrResult, ExecutionContext, OkResult, Result } from '../packages/node-vfs/src/types'
import { Buffer } from 'node:buffer'
import { expect } from 'vitest'
import { NEVER_ABORT } from '../packages/node-vfs/src/utils/signal'

/** Default limits mirroring `createVFS`'s internal DEFAULT_LIMITS. */
export const TEST_LIMITS = {
  maxFileSize: 10 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxExecuteMs: 60_000,
  maxEditSize: 1024 * 1024,
} as const

/** Build an ExecutionContext; `limits` are merged (partial overrides allowed). */
export function makeCtx(
  overrides?: Partial<Omit<ExecutionContext, 'limits'>> & { limits?: Partial<ExecutionContext['limits']> },
): ExecutionContext {
  const { limits, ...rest } = overrides ?? {}
  return {
    signal: NEVER_ABORT,
    limits: { ...TEST_LIMITS, ...limits },
    ...rest,
  }
}

/** Assert the result is ok, then return it narrowed to the ok variant. */
export function expectOkResult<T, M = Record<string, unknown>>(result: Result<T, M>): OkResult<T, M> {
  if (!result.ok) {
    const detail = result.meta ? `\nDetail: ${JSON.stringify(result.meta)}` : ''
    throw new Error(`Expected ok result, got ${result.code}: ${result.error}${detail}`)
  }
  expect(result.ok).toBe(true)
  return result
}

/** Assert the result is an error, then return it narrowed to the error variant. */
export function expectErrResult<T, M = Record<string, unknown>>(result: Result<T, M>): ErrResult {
  if (result.ok) {
    throw new Error(`Expected error result, got ok (${JSON.stringify(result.data)})`)
  }
  expect(result.ok).toBe(false)
  return result
}

/** Drain a byte stream into a utf8 string. */
export async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Drain an arbitrary stream into an array. */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of stream) {
    out.push(item)
  }
  return out
}
