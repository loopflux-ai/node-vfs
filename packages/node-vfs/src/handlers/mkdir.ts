import type { StorageBackend } from '../backend/storage.ts'
import type { ExecutionContext, MkdirMeta, MkdirOp, MkdirResult, Result } from '../types.ts'
import { err, ERR } from '../errors.ts'

/** Create a directory (recursively, idempotently — like `mkdir -p`). */
export async function handleMkdir(
  backend: StorageBackend,
  op: MkdirOp,
  ctx: ExecutionContext,
): Promise<Result<MkdirResult, MkdirMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  // Root always exists — idempotent success.
  if (op.path === '/') {
    return {
      ok: true as const,
      data: { path: '/', wasCreated: false },
      meta: { path: '/', wasCreated: false },
      tokens: 0,
    }
  }
  const r = await backend.mkdir(op.path)
  return {
    ok: true as const,
    data: { path: op.path, wasCreated: r.wasCreated },
    meta: { path: op.path, wasCreated: r.wasCreated },
    tokens: 0,
  }
}
