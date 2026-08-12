/**
 * Logging middleware — emits structured entries per op lifecycle event.
 *
 * Records both 'start' and 'end' phases so slow or hung operations are
 * visible before they complete (mirrors the VFSDebugger pattern of
 * bracketing an operation with begin/end events).
 *
 * Place outermost so cache hits are also recorded.
 */

import type { Op, Result } from '../types.ts'
import type { Middleware } from './compose.ts'
import { performance } from 'node:perf_hooks'
import { OP_KIND } from '../handlers/kinds.ts'

/** Start event — emitted before the handler runs. */
export interface LogEntryStart {
  phase: 'start'
  /** Operation ID — correlates start and end entries. */
  opId: string
  opKind: string
  path?: string
  /** Execute command — present when opKind is 'execute'. */
  execute?: { command: string }
}

/** End event — emitted after the handler completes (or throws). */
export interface LogEntryEnd {
  phase: 'end'
  /** Operation ID — correlates start and end entries. */
  opId: string
  opKind: string
  path?: string
  ok: boolean
  durationMs: number
  /** Error code (NOT_FOUND, PERMISSION_DENIED, …) when !ok. */
  code?: string
  /** Byte count from meta (bytesReturned / bytesWritten / stdoutBytes). */
  bytes?: number
  /**
   * Execute-specific payload — present when opKind is 'execute'.
   * `command` is always set; `exitCode` is absent when the subprocess never
   * ran (guard-rejected, aborted, unsupported).
   */
  execute?: { command: string, exitCode?: number }
  /**
   * Normalised outcome of the operation — derived from ok/code/exitCode.
   * Set on end events emitted by this middleware; see `OpStatus`.
   */
  status: OpStatus
}

/** Normalised operation outcome carried by LogEntryEnd.status. */
export type OpStatus = 'success' | 'failed' | 'cancelled' | 'rejected' | 'error'

export type LogEntry = LogEntryStart | LogEntryEnd

export interface LoggingOptions {
  log: (entry: LogEntry) => void
}

/**
 * Derive the normalised outcome for LogEntryEnd.status.
 *
 * - ABORTED           → 'cancelled' (signal cancellation)
 * - PERMISSION_DENIED → 'rejected'  (policy deny or execute guard)
 * - other errors      → 'error'
 * - ok execute        → 'success' / 'failed' by exitCode
 * - ok non-execute    → 'success'
 * - undefined result  → 'error' (next() threw before returning)
 */
function deriveStatus(op: Op, result: Result<unknown, unknown> | undefined): OpStatus {
  if (!result)
    return 'error'
  if (!result.ok) {
    if (result.code === 'ABORTED')
      return 'cancelled'
    if (result.code === 'PERMISSION_DENIED')
      return 'rejected'
    return 'error'
  }
  if (op.kind === OP_KIND.EXECUTE) {
    // Read exitCode from meta — the same source as LogEntryEnd.execute.exitCode,
    // so the status and the exitCode field can never contradict each other.
    const meta = result.meta as { exitCode?: number }
    return meta.exitCode === 0 ? 'success' : 'failed'
  }
  return 'success'
}

export function createLoggingMiddleware(opts: LoggingOptions): Middleware {
  return async (_ctx, op, next) => {
    const path = 'path' in op ? (op as { path: string }).path : undefined
    const command = op.kind === OP_KIND.EXECUTE
      ? (op as { command: string }).command
      : undefined

    // Start event — emitted before the handler runs so slow or hung operations
    // are not invisible until completion.
    opts.log({
      phase: 'start',
      opId: op.id,
      opKind: op.kind,
      ...(path !== undefined ? { path } : {}),
      ...(command !== undefined ? { execute: { command } } : {}),
    })

    const start = performance.now()
    try {
      const result = await next()
      const durationMs = performance.now() - start

      const entry: LogEntryEnd = {
        phase: 'end',
        opId: op.id,
        opKind: op.kind,
        ok: result.ok,
        durationMs,
        status: deriveStatus(op, result),
        ...(path !== undefined ? { path } : {}),
        ...(command !== undefined ? { execute: { command } } : {}),
      }
      if (!result.ok) {
        entry.code = result.code
      }
      if (result.ok && result.meta && typeof result.meta === 'object') {
        const meta = result.meta as Record<string, unknown>
        if (typeof meta.bytesReturned === 'number')
          entry.bytes = meta.bytesReturned
        else if (typeof meta.bytesWritten === 'number')
          entry.bytes = meta.bytesWritten
        else if (typeof meta.stdoutBytes === 'number')
          entry.bytes = meta.stdoutBytes
        if (op.kind === OP_KIND.EXECUTE && entry.execute) {
          if (typeof meta.exitCode === 'number')
            entry.execute.exitCode = meta.exitCode
        }
      }
      opts.log(entry)

      return result
    }
    catch (e) {
      // Ensure the end event is always emitted so start/end entries pair up —
      // otherwise a thrown exception leaves an orphaned start entry and the
      // operation appears to still be running.
      const durationMs = performance.now() - start
      opts.log({
        phase: 'end',
        opId: op.id,
        opKind: op.kind,
        ok: false,
        durationMs,
        status: deriveStatus(op, undefined),
        ...(path !== undefined ? { path } : {}),
        ...(command !== undefined ? { execute: { command } } : {}),
      })
      throw e
    }
  }
}
