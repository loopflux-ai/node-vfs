/** Op kind constants — single source of truth for kind string literals. */

import type { CommandOp, QueryOp } from '../types.ts'

export const OP_KIND = {
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT_FILE: 'edit_file',
  DELETE_FILE: 'delete_file',
  MKDIR: 'mkdir',
  GREP: 'grep',
  LS: 'ls',
  GLOB: 'glob',
  EXECUTE: 'execute',
} as const

/** QueryOp: read_file / grep / ls / glob. */
export function isQueryOp(op: { kind: string }): op is QueryOp {
  return op.kind === OP_KIND.READ_FILE || op.kind === OP_KIND.GREP || op.kind === OP_KIND.LS || op.kind === OP_KIND.GLOB
}

/** CommandOp: write_file / edit_file / delete_file / mkdir / execute. */
export function isCommandOp(op: { kind: string }): op is CommandOp {
  return op.kind === OP_KIND.WRITE_FILE || op.kind === OP_KIND.EDIT_FILE || op.kind === OP_KIND.DELETE_FILE || op.kind === OP_KIND.MKDIR || op.kind === OP_KIND.EXECUTE
}
