/**
 * Policy middleware — dual-purpose `deny` patterns:
 * 1. Pre-handler: reject direct access to denied paths (PERMISSION_DENIED).
 * 2. Post-handler: filter denied entries from ls/glob/grep results.
 *
 * Execute command restrictions are NOT part of this middleware — they live in
 * `createVFS({ execute: [...] })` (default-deny allow-list). This middleware
 * only validates an execute op's declared `affectedPaths` against `deny`.
 *
 * @example `createPolicyMiddleware({ deny: [/\/\./] })` — block all dotfiles.
 */

import type { ErrSpec } from '../errors.ts'
import type { ExecutionContext, GrepMatch, ListEntry, Op, Result } from '../types.ts'
import type { Middleware } from './compose.ts'
import { err } from '../errors.ts'
import { OP_KIND } from '../handlers/kinds.ts'
import { isHostAbsolutePath } from '../path.ts'

export interface PolicyOptions {
  /** Paths matching these patterns are denied (direct ops) or filtered (listings). */
  deny: RegExp[]
}

/**
 * Build a policy-specific PERMISSION_DENIED spec.
 *
 * The generic `ERR.PERMISSION_DENIED` stays neutral (it cannot know whether
 * the source is OS EACCES, the execute guard, or this middleware). Policy deny
 * is the one source that knows its cause for certain, so it owns the precise,
 * LLM-actionable message here — `errors.ts` is kept free of middleware-specific
 * concepts.
 */
function policyDeniedSpec(path: string, pattern: string): ErrSpec {
  return {
    code: 'PERMISSION_DENIED',
    error: `Permission denied by policy: "${path}" matches deny pattern /${pattern}/`,
    suggestions: [
      `Choose a path that does not match the deny pattern /${pattern}/`,
      `The path is blocked by policy, not an OS permission issue — do not retry the same path`,
    ],
  }
}

/**
 * Normalize a path before matching deny patterns, so the same file is denied
 * consistently whether the caller used a relative (".env"), virtual-absolute
 * ("/.env") or nested ("foo/.env") form. Without this, a pattern like
 * `/\/\./` silently missed the relative root form `.env`.
 */
function normalizeForPolicy(path: string): string {
  if (path.startsWith('/') || isHostAbsolutePath(path))
    return path
  return `/${path}`
}

export function createPolicyMiddleware(options: PolicyOptions): Middleware {
  const { deny } = options

  // Fast path: zero-overhead with an empty deny list.
  if (deny.length === 0) {
    return async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => await next()
  }

  // Normalize deny patterns: strip /g and /y so repeated test() calls stay
  // deterministic. With /g or /y, lastIndex advances across calls and a
  // pattern can silently miss entries (e.g. filtering a listing where a
  // matched entry advances lastIndex past the next match). Mirrors the
  // execute guard's normalizeEntry handling of the same trap.
  const denyPatterns = deny.map(re =>
    re.global || re.sticky
      ? new RegExp(re.source, re.flags.replace(/[gy]/g, ''))
      : re,
  )

  const isDenied = (path: string): boolean => denyPatterns.some(re => re.test(normalizeForPolicy(path)))

  return async (_ctx: ExecutionContext, op: Op, next: () => Promise<Result<unknown, unknown>>) => {
    // Pre-handler: validate an execute op's declared affected paths against
    // the deny list, mirroring file ops (affectedPaths: [".env"] is denied
    // just like delete_file).
    if (op.kind === OP_KIND.EXECUTE) {
      const affected = (op as { affectedPaths?: string[] }).affectedPaths
      if (affected) {
        for (const p of affected) {
          if (isDenied(p)) {
            const pattern = denyPatterns.find(re => re.test(normalizeForPolicy(p)))?.source ?? ''
            return err(op.id, op.kind, policyDeniedSpec(p, pattern), {
              patterns: deny.map(r => r.source),
            })
          }
        }
      }
    }
    // Pre-handler: reject direct access.
    if ('path' in op) {
      const path = (op as { path: string }).path
      if (isDenied(path)) {
        const pattern = denyPatterns.find(re => re.test(normalizeForPolicy(path)))?.source ?? ''
        return err(op.id, op.kind, policyDeniedSpec(path, pattern), {
          patterns: deny.map(r => r.source),
        })
      }
    }

    const result = await next()
    if (!result.ok)
      return result

    // Post-handler: filter listings.
    if (op.kind === OP_KIND.LS || op.kind === OP_KIND.GLOB) {
      const data = result.data as { entries: ListEntry[], nextCursor?: string }
      const filtered = data.entries.filter(e => !isDenied(e.path))
      if (filtered.length === data.entries.length)
        return result
      return { ...result, data: { entries: filtered, nextCursor: data.nextCursor } }
    }

    if (op.kind === OP_KIND.GREP) {
      const stream = result.data as AsyncIterable<GrepMatch>
      const filtered: AsyncIterable<GrepMatch> = {
        async* [Symbol.asyncIterator]() {
          for await (const match of stream) {
            if (!isDenied(match.path))
              yield match
          }
        },
      }
      return { ...result, data: filtered }
    }

    return result
  }
}
