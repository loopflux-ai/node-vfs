/**
 * Quota middleware — in-memory byte-count limit per VFS instance.
 * Pre-handler checks write/edit delta; post-handler updates counter.
 * Soft limit — resets on restart, sufficient for abuse prevention.
 */

import type {
  EditFileOp,
  ExecutionContext,
  Op,
  Result,
  WriteFileOp,
} from '../types.ts'
import type { Middleware } from './compose.ts'
import { err, ERR } from '../errors.ts'
import { OP_KIND } from '../handlers/kinds.ts'
import { withMutex } from '../utils/mutex.ts'

export interface QuotaMiddlewareOptions {
  maxBytes?: number
}

export function createQuotaMiddleware(options: QuotaMiddlewareOptions = {}): Middleware {
  const { maxBytes } = options
  const locks = new Map<string, Promise<unknown>>()
  let usedBytes = 0

  function estimateDelta(op: WriteFileOp | EditFileOp): number {
    if (op.kind === OP_KIND.WRITE_FILE) {
      const content = typeof op.content === 'string'
        ? new TextEncoder().encode(op.content).byteLength
        : op.content.byteLength
      return content
    }
    return Math.max(0, (op.newText.length - op.oldText.length))
  }

  return async (_ctx: ExecutionContext, op: Op, next: () => Promise<Result<unknown, unknown>>) => {
    // All byte-count mutations (write/edit/delete) run under a single mutex so
    // the counter cannot drift under concurrency (delete previously updated
    // `usedBytes` outside the lock).
    if (op.kind === OP_KIND.WRITE_FILE || op.kind === OP_KIND.EDIT_FILE || op.kind === OP_KIND.DELETE_FILE) {
      return withMutex(locks, 'quota:check', async () => {
        // Pre-handler: check quota before I/O.
        if (op.kind === OP_KIND.WRITE_FILE || op.kind === OP_KIND.EDIT_FILE) {
          const deltaBytes = estimateDelta(op)
          if (deltaBytes > 0 && maxBytes && usedBytes + deltaBytes > maxBytes) {
            return err(op.id, op.kind, ERR.CAPACITY_EXCEEDED(usedBytes + deltaBytes, maxBytes))
          }
        }

        const result = await next()
        if (!result.ok)
          return result

        if (op.kind === OP_KIND.WRITE_FILE || op.kind === OP_KIND.EDIT_FILE) {
          const deltaBytes = estimateDelta(op)
          const actualDelta = (result.meta as { deltaBytes?: number }).deltaBytes ?? deltaBytes
          usedBytes += actualDelta
        }
        else if (op.kind === OP_KIND.DELETE_FILE) {
          const meta = result.meta as { bytesFreed?: number }
          usedBytes = Math.max(0, usedBytes - (meta.bytesFreed ?? 0))
        }

        return result
      })
    }

    return await next()
  }
}

export {}
