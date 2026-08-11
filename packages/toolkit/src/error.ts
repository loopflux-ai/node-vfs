import type { ErrResult, OpKind } from '@loopflux/node-vfs'

/**
 * Build a tool error from a VFS ErrResult, appending structured suggestions
 * so LLM agents receive actionable diagnostics on failure.
 *
 * @example `read_file failed: NOT_FOUND — Path not found: /missing.txt\nSuggestions:\n- ...`
 */
export function formatToolError(operation: string, result: ErrResult): Error {
  const base = `${operation} failed: ${result.code} — ${result.error}`
  if (result.suggestions.length === 0)
    return new Error(base)
  return new Error(`${base}\nSuggestions:\n- ${result.suggestions.join('\n- ')}`)
}

/**
 * Wrap a thrown stream-iteration error into a structured tool error.
 *
 * Only read_file exposes a lazy stream: when the cache is disabled
 * (`cache: false`), backend errors (EACCES, ENOENT mid-read, …) surface as
 * throws during consumption rather than as ErrResults at the call site. grep
 * eagerly materialises matches inside the handler, so its result stream is
 * pre-populated and never throws. The thrown error carries a mapped `.code`
 * but not the full ErrSpec, so suggestions are unavailable for stream-surfaced
 * errors (the cache-on path retains them).
 */
export function formatStreamError(kind: OpKind, e: unknown): Error {
  const code = e !== null && typeof e === 'object' && 'code' in e
    ? String((e as { code: unknown }).code)
    : 'INTERNAL_ERROR'
  const error = e instanceof Error ? e.message : 'stream iteration failed'
  return formatToolError(kind, {
    ok: false,
    code,
    error,
    suggestions: [],
    opId: '',
    kind,
  })
}
