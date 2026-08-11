/**
 * Logging middleware — emits structured entries per op lifecycle event.
 *
 * Records both 'start' and 'end' phases so slow or hung operations are
 * visible before they complete (mirrors the VFSDebugger pattern of
 * bracketing an operation with begin/end events).
 *
 * Place outermost so cache hits are also recorded.
 */

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
  /** Command when opKind is 'execute'. */
  command?: string
}

/** End event — emitted after the handler completes (or throws). */
export interface LogEntryEnd {
  phase: 'end'
  /** Operation ID — correlates start and end entries. */
  opId: string
  opKind: string
  path?: string
  /** Command when opKind is 'execute'. */
  command?: string
  ok: boolean
  durationMs: number
  /** Error code (NOT_FOUND, PERMISSION_DENIED, …) when !ok. */
  code?: string
  /** Byte count from meta. */
  bytes?: number
  /** Exit code when opKind is 'execute'. */
  exitCode?: number
}

export type LogEntry = LogEntryStart | LogEntryEnd

export interface LoggingOptions {
  log: (entry: LogEntry) => void
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
      ...(command !== undefined ? { command } : {}),
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
        ...(path !== undefined ? { path } : {}),
        ...(command !== undefined ? { command } : {}),
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
        if (op.kind === OP_KIND.EXECUTE) {
          if (typeof meta.exitCode === 'number')
            entry.exitCode = meta.exitCode
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
        ...(path !== undefined ? { path } : {}),
        ...(command !== undefined ? { command } : {}),
      })
      throw e
    }
  }
}
