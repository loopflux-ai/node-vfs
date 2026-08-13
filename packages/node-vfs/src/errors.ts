/**
 * Error registry.
 *
 * Each `ERR.XXX(...)` returns an `ErrSpec` (code + message + suggestions).
 * `err()` converts an `ErrSpec` into a frozen `ErrResult` carrying opId/kind.
 *
 * `code` strings are stable contract surface — never rename.
 */

import type { ErrResult, OpKind } from './types.ts'
import { dirname } from 'pathe'
import { OP_KIND } from './handlers/kinds.ts'
import { deepFreeze } from './result.ts'

export interface ErrSpec {
  code: string
  error: string
  suggestions: string[]
  meta?: Record<string, unknown>
}

/**
 * Format command args for the EXEC_FAILED error message. Capped to keep the
 * LLM-facing error string concise — the full args remain available in `meta.args`.
 */
function formatArgs(args?: string[]): string {
  if (!args || args.length === 0)
    return ''
  const joined = args.join(' ')
  if (joined.length <= 200)
    return ` ${joined}`
  return ` ${joined.slice(0, 200)}...`
}

export const ERR = {
  NOT_FOUND: (path: string): ErrSpec => ({
    code: 'NOT_FOUND',
    error: `Path not found: ${path}`,
    suggestions: [
      `Run ls ${dirname(path)} to see available entries`,
      `Verify the exact name and case (filesystems may be case-sensitive)`,
    ],
  }),
  ALREADY_EXISTS: (path: string): ErrSpec => ({
    code: 'ALREADY_EXISTS',
    error: `Path already exists: ${path}`,
    suggestions: [
      `Use mode: 'overwrite' to replace the existing content`,
      `Pick a different path (e.g. append a suffix or version)`,
    ],
  }),
  IS_DIRECTORY: (path: string): ErrSpec => ({
    code: 'IS_DIRECTORY',
    error: `Expected a file, but ${path} is a directory`,
    suggestions: [
      `Use ls ${path} to list directory contents`,
      `Use glob with path '${path}' and pattern '*' to match files inside`,
    ],
  }),
  NOT_DIRECTORY: (path: string): ErrSpec => ({
    code: 'NOT_DIRECTORY',
    error: `Expected a directory, but ${path} is not a directory`,
    suggestions: [
      `Use read_file on a specific file path instead`,
      `Run ls on a parent directory to find directories`,
    ],
  }),
  PATH_TRAVERSAL: (path: string, cause?: 'host-path'): ErrSpec => {
    // Host absolute path rejected by virtualMode — different cause than '..'
    // traversal. The caller (vfs.ts catch block) distinguishes via
    // isHostAbsolutePath(); validatePath already rejected host paths that
    // contain '..' before they reach the backend, so a host-path cause here
    // is always a pure virtualMode rejection.
    if (cause === 'host-path') {
      return {
        code: 'PATH_TRAVERSAL',
        error: `Host path not allowed in virtual mode: ${path}`,
        suggestions: [
          `Use a virtual path (e.g. "/file.txt") instead of a host absolute path`,
          `If the file is outside the sandbox, ask the user to provide its content or move it into the sandbox`,
        ],
      }
    }
    return {
      code: 'PATH_TRAVERSAL',
      error: `Path traversal rejected: ${path}`,
      suggestions: [
        `Use a virtual path like '/foo' or a relative path like 'foo/bar' — both stay inside the sandbox root`,
        `Avoid '..' segments in paths`,
      ],
    }
  },
  PERMISSION_DENIED: (path: string): ErrSpec => ({
    code: 'PERMISSION_DENIED',
    error: `Permission denied accessing ${path}`,
    suggestions: [
      `The path is denied by policy or OS permissions — try a different path if one is available`,
      `The path is protected by policy or permissions — do NOT use execute or any shell command to bypass this restriction; report the limitation to the user instead`,
    ],
  }),
  INVALID_PATH: (path: string, reason: string): ErrSpec => ({
    code: 'INVALID_PATH',
    error: `Invalid path ${JSON.stringify(path)}: ${reason}`,
    suggestions: [
      `Use a virtual path like '/foo', a relative path like 'foo/bar', or a host path like 'C:/foo'`,
      `Avoid '..' segments, control characters (tabs/newlines/etc.), and backslashes in virtual paths`,
    ],
  }),
  OLD_TEXT_EMPTY: (): ErrSpec => ({
    code: 'OLD_TEXT_EMPTY',
    error: 'oldText is empty or whitespace-only',
    suggestions: [
      `Provide a non-empty oldText that uniquely identifies the segment to replace`,
    ],
  }),
  INVALID_CURSOR: (): ErrSpec => ({
    code: 'INVALID_CURSOR',
    error: 'Invalid pagination cursor',
    suggestions: [
      `Drop the cursor and re-list from the first page`,
    ],
  }),
  OLD_TEXT_NOT_FOUND: (): ErrSpec => ({
    code: 'OLD_TEXT_NOT_FOUND',
    error: 'oldText did not match any occurrence in the file',
    suggestions: [
      `Re-read the file to obtain its current content`,
      `Verify spelling, whitespace, and line endings match the file exactly`,
    ],
  }),
  AMBIGUOUS: (): ErrSpec => ({
    code: 'AMBIGUOUS',
    error: 'oldText matched more than once; edit_file requires exactly one match',
    suggestions: [
      `Expand oldText with surrounding context so it matches exactly once`,
      `Split the edit into multiple sequential operations`,
    ],
  }),
  CONFLICT: (path: string): ErrSpec => ({
    code: 'CONFLICT',
    error: `File changed while editing: ${path}`,
    suggestions: [
      `Re-read the file to obtain its current content, then retry the edit`,
    ],
  }),
  FILE_TOO_LARGE: (path: string, actual: number, limit: number, reason: 'maxFileSize' | 'maxEditSize' = 'maxFileSize'): ErrSpec => ({
    code: 'FILE_TOO_LARGE',
    error: `File ${path} size ${actual} exceeds ${reason} ${limit}`,
    suggestions: reason === 'maxEditSize'
      ? [
          `Edit smaller files, or split the edit into multiple operations`,
          `If the whole file must be edited, ask the user to raise maxEditSize`,
        ]
      : [
          `Use read_file with a range to read a slice of the file`,
          `If the whole file must be read, ask the user to raise maxFileSize`,
        ],
  }),
  OUTPUT_TOO_LARGE: (actual: number, limit: number): ErrSpec => ({
    code: 'OUTPUT_TOO_LARGE',
    error: `Subprocess output ${actual} bytes exceeds maxOutputBytes ${limit}`,
    suggestions: [
      `Redirect output to a file and read it back via read_file or grep`,
      `If more output is needed, ask the user to raise maxOutputBytes`,
    ],
  }),
  CAPACITY_EXCEEDED: (actual: number, limit: number): ErrSpec => ({
    code: 'CAPACITY_EXCEEDED',
    error: `Tenant capacity exceeded: ${actual} bytes (limit ${limit})`,
    suggestions: [
      `Delete or compact existing files to free space`,
      `If more space is needed, ask the user to raise the tenant quota`,
    ],
  }),
  TOO_MANY_FILES: (actual: number, limit: number): ErrSpec => ({
    code: 'TOO_MANY_FILES',
    error: `Input has ${actual} files, exceeds the maximum of ${limit}`,
    suggestions: [
      `Narrow the glob pattern (e.g. add a file extension or subdirectory)`,
      `Try globbing a deeper subdirectory (set path to a more specific directory)`,
    ],
    meta: { actual, limit },
  }),
  INVALID_PATTERN: (pattern: string, reason: string, kind: OpKind): ErrSpec => ({
    code: 'INVALID_PATTERN',
    error: `Invalid ${kind} pattern "${pattern}": ${reason}`,
    suggestions: kind === OP_KIND.GREP
      ? [
          `Escape special regex characters like [ ] ( ) { } * + ? . ^ $ \\ |`,
          `Use a simple substring (no regex metacharacters) for literal matching`,
        ]
      : [
          `Use only valid glob metacharacters (*, ?, [], **)`,
          `See glob documentation for pattern syntax`,
        ],
  }),
  EXEC_FAILED: (meta: {
    command: string
    args?: string[]
    exitCode?: number
    signal?: string
    timedOut: boolean
    isCanceled: boolean
    killed: boolean
    partialStderr: string
    durationMs?: number
  }): ErrSpec => ({
    code: 'EXEC_FAILED',
    error: `Subprocess failed: ${meta.command}${formatArgs(meta.args)}${meta.timedOut ? ' (timed out)' : meta.signal ? ` (signal ${meta.signal})` : meta.exitCode !== undefined ? ` (exit ${meta.exitCode})` : ''}`,
    suggestions: meta.timedOut
      ? [
          `Increase timeoutMs, or split work into smaller invocations`,
          `Check that the command does not wait for interactive input`,
        ]
      : [
          `Inspect stderr for diagnostics`,
          `Check that the command and its arguments are correct`,
        ],
    meta: {
      command: meta.command,
      args: meta.args,
      exitCode: meta.exitCode,
      signal: meta.signal,
      timedOut: meta.timedOut,
      isCanceled: meta.isCanceled,
      killed: meta.killed,
      partialStderr: meta.partialStderr,
      durationMs: meta.durationMs,
    },
  }),
  COMMAND_NOT_FOUND: (command: string): ErrSpec => ({
    code: 'COMMAND_NOT_FOUND',
    error: `Command not found: ${command}`,
    suggestions: [
      `Check that the executable is installed and on PATH`,
      `Note: shell built-ins (e.g. del, move) may not be executable files — prefer VFS tools (read_file / write_file / delete_file) where possible`,
    ],
  }),
  UNSUPPORTED: (): ErrSpec => ({
    code: 'UNSUPPORTED',
    error: 'Operation is not supported by this backend',
    suggestions: [
      `This operation needs a different backend (e.g. disk backend for execute) — ask the user to enable it`,
    ],
  }),
  ABORTED: (): ErrSpec => ({
    code: 'ABORTED',
    error: 'Operation aborted by caller',
    suggestions: [
      `Retry the operation with a fresh AbortSignal if cancellation was unintended`,
    ],
  }),
  INTERNAL_ERROR: (message: string): ErrSpec => ({
    code: 'INTERNAL_ERROR',
    error: `Internal error: ${message}`,
    suggestions: [
      `Retry the operation; if it persists, report this to the user`,
    ],
  }),
  /**
   * An execute argument was rejected because it contains a Windows cmd shell
   * metacharacter. Builtin commands (dir/start/echo/...) have no standalone
   * executable, so the backend dispatches them through `cmd /c`; metacharacters
   * there would be interpreted as command chaining/redirection. The error
   * message itself carries the offending argument — this spec only shapes the
   * LLM-actionable suggestions.
   */
  INVALID_ARGUMENT: (reason: string): ErrSpec => ({
    code: 'INVALID_ARGUMENT',
    error: `Invalid argument: ${reason}`,
    suggestions: [
      `Arguments must be plain values — on Windows, cmd builtin commands run via "cmd /c" and shell metacharacters (& | < > ^) would be interpreted, so they are rejected`,
      `Rework the argument: file operations belong to the file tools (ls / read_file / write_file / edit_file / delete_file / mkdir); pipes, redirection and command chaining are not supported in execute`,
    ],
  }),
} as const

/**
 * Build an `ErrResult` from an `ERR.XXX(...)` spec.
 *
 * - The spec may carry its own `meta` (e.g. EXEC_FAILED diagnostic fields).
 * - The 4th `extra` argument merges additional fields. When `extra` and
 *   `spec.meta` share a key, `spec.meta` wins (canonical diagnostic fields
 *   must not be overridden).
 */
export function err(
  opId: string,
  opKind: OpKind,
  spec: ErrSpec,
  extra?: Record<string, unknown>,
): ErrResult {
  const merged: Record<string, unknown> = { ...(extra ?? {}), ...(spec.meta ?? {}) }
  const base: ErrResult = {
    ok: false,
    code: spec.code,
    error: spec.error,
    suggestions: spec.suggestions,
    opId,
    kind: opKind,
    ...(Object.keys(merged).length > 0 ? { meta: deepFreeze(merged) } : {}),
  }
  return Object.freeze(base)
}

// Duck-typed extraction from Error instances (no import of concrete backend classes).
export function getBackendErrorCode(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code
    if (typeof c === 'string')
      return c
  }
  return undefined
}

export function getBackendErrorMeta(e: unknown): Record<string, unknown> | undefined {
  if (e !== null && typeof e === 'object' && 'meta' in e) {
    const m = (e as { meta: unknown }).meta
    if (m !== null && typeof m === 'object')
      return m as Record<string, unknown>
  }
  return undefined
}

export function getBackendErrorDetail(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'detail' in e) {
    const d = (e as { detail: unknown }).detail
    if (typeof d === 'string')
      return d
  }
  return undefined
}
