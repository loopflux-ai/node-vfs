/** Op dispatch table — maps OpKind to pure handler functions. */

import type { StorageBackend } from '../backend/storage.ts'
import type { ExecutionContext, Op, OpData, OpFor, OpKind, OpMeta, Result } from '../types.ts'
import { handleExecute } from './execute.ts'
import { handleDeleteFile, handleEditFile, handleReadFile, handleWriteFile } from './files.ts'
import { OP_KIND } from './kinds.ts'
import { handleMkdir } from './mkdir.ts'
import { handleGlob, handleGrep, handleLs } from './query.ts'

type Handler<K extends OpKind> = (
  backend: StorageBackend,
  op: OpFor<K>,
  ctx: ExecutionContext,
) => Promise<Result<OpData<K>, OpMeta<K>>>

const handlers: { [K in OpKind]: Handler<K> } = {
  [OP_KIND.READ_FILE]: handleReadFile,
  [OP_KIND.WRITE_FILE]: handleWriteFile,
  [OP_KIND.EDIT_FILE]: handleEditFile,
  [OP_KIND.DELETE_FILE]: handleDeleteFile,
  [OP_KIND.MKDIR]: handleMkdir,
  [OP_KIND.GREP]: handleGrep,
  [OP_KIND.LS]: handleLs,
  [OP_KIND.GLOB]: handleGlob,
  [OP_KIND.EXECUTE]: handleExecute,
}

export function dispatch(
  backend: StorageBackend,
  op: Op,
  ctx: ExecutionContext,
): Promise<Result<unknown, unknown>> {
  const handler = handlers[op.kind] as Handler<typeof op.kind> | undefined
  if (!handler) {
    return Promise.resolve({
      ok: false as const,
      code: 'UNSUPPORTED',
      error: `No handler for op.kind=${op.kind}`,
      suggestions: ['Use one of: read_file, write_file, edit_file, delete_file, mkdir, grep, ls, glob, execute'],
      opId: op.id,
      kind: op.kind as OpKind,
    })
  }
  return handler(backend, op as never, ctx) as Promise<Result<unknown, unknown>>
}
