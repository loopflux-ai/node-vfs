/**
 * Execute handler — duck-types backend.execute.
 *
 * Security model (default-deny allow-list):
 * - execute is DISABLED by default. `createVFS({ execute: { allowCommands: [...] } })`
 *   enables it with an allow-list: each entry is a command name (basename
 *   match) or a RegExp matched against the command field.
 *   - `execute` not set / `allowCommands: []` → every execute op is rejected
 *   - `allowCommands: ['node', 'git']` → only those commands (exact basename)
 *   - `allowCommands: [/^git/, 'npm']` → regex + name entries mixed
 * - The subprocess env inherits the full host `process.env` by default;
 *   `execute: { envBlocklist: [...] }` strips matching host vars before spawn
 *   (exact names, case-insensitive, or RegExp patterns).
 *
 * Threat model: the VFS sandbox boundary is `virtualMode` × policy deny-list.
 * The file tools reach host paths when virtualMode is false. An allow-list
 * restricts the execute channel's command *shape* — it cannot stop arbitrary
 * code (`node script.js`) or absolute host paths; use containers or a
 * sandboxed user for adversarial isolation.
 */

import type { StorageBackend } from '../backend/storage.ts'
import type {
  ExecuteAllowItem,
  ExecuteAllowList,
  ExecuteConfig,
  ExecuteMeta,
  ExecuteOp,
  ExecuteReceipt,
  ExecuteResult,
  ExecutionContext,
  Result,
} from '../types.ts'
import { Buffer } from 'node:buffer'
import { err, ERR, getBackendErrorCode, getBackendErrorDetail, getBackendErrorMeta } from '../errors.ts'
import { estimateBinaryTokens, estimateTextTokens } from '../utils/tokens.ts'

export type { ExecuteAllowItem, ExecuteAllowList }

export interface ExecuteGuardResult {
  allowed: boolean
  /** Reject reason, for diagnostics. */
  reason?: 'denyAll' | 'allowList'
  /** Reject message, for diagnostics. */
  detail?: string
}

/** Normalized allow entry: exact command name or RegExp pattern. */
type AllowEntry
  = | { type: 'name', value: string }
    | { type: 'pattern', re: RegExp }

/** Normalize a user allow entry. */
function normalizeEntry(item: ExecuteAllowItem): AllowEntry {
  if (item instanceof RegExp) {
    // Strip global/sticky flags: `test()` with /g or /y mutates lastIndex,
    // making repeated checks of the same command non-deterministic.
    const flags = item.flags.replace(/[gy]/g, '')
    return { type: 'pattern', re: new RegExp(item.source, flags) }
  }
  return { type: 'name', value: parseCommandName(item) }
}

/**
 * First token of a command: a quoted path (may contain spaces) or a word.
 * Empty string when the command is blank.
 */
function firstToken(command: string): string {
  const trimmed = command.trim()
  const quoted = /^(["'])(.*?)\1/.exec(trimmed)
  if (quoted)
    return quoted[2]
  const word = /^\S+/.exec(trimmed)
  if (word)
    return word[0]
  return ''
}

/**
 * Parses a command into a comparable lowercase basename.
 * `del .env` → `del`; `C:\Windows\System32\cmd.exe /c ...` → `cmd`;
 * `"C:\Program Files\nodejs\node.exe" -e x` → `node`.
 */
export function parseCommandName(command: string): string {
  const token = firstToken(command)
  const base = token.split(/[\\/]/).pop() ?? token
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase()
}

/**
 * Builds the execute guard. `allow` undefined/empty ⇒ default-deny.
 */
export function buildExecuteGuard(allow?: ExecuteAllowList): (command: string) => ExecuteGuardResult {
  const entries: AllowEntry[] = (allow ?? []).map(normalizeEntry)

  return (command: string): ExecuteGuardResult => {
    // Default-deny: no allow-list → every command rejected.
    if (entries.length === 0)
      return { allowed: false, reason: 'denyAll', detail: 'execute is disabled by default' }

    const name = parseCommandName(command)
    const allowed = entries.some(e => e.type === 'name' ? e.value === name : e.re.test(command))
    if (!allowed)
      return { allowed: false, reason: 'allowList', detail: `command "${name}" is not allowed` }

    return { allowed: true }
  }
}

export async function handleExecute(
  backend: StorageBackend,
  op: ExecuteOp,
  ctx: ExecutionContext,
): Promise<Result<ExecuteResult, ExecuteMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  // execute is on FilesystemBackend only — duck-typed.
  if (typeof (backend as { execute?: unknown }).execute !== 'function') {
    return err(op.id, op.kind, ERR.UNSUPPORTED(), { hint: 'backend has no execute() — use FilesystemBackend' })
  }
  // Default-deny: execute is disabled unless the VFS config provides an
  // allow-list.
  const guard = buildExecuteGuard(ctx.executeConfig?.allowCommands)
  const check = guard(op.command)
  if (!check.allowed) {
    const suggestion = check.reason === 'allowList'
      ? 'The command is not in the allow-list — add it to createVFS({ execute: { allowCommands: [...] } }) to permit it.'
      : 'execute is disabled by default — enable it via createVFS({ execute: { allowCommands: [...] } }) with an allow-list (command names or regexes).'
    return err(op.id, op.kind, ERR.PERMISSION_DENIED(`execute "${op.command}"`), {
      reason: check.reason,
      detail: check.detail,
      suggestion,
    })
  }
  const sandbox = backend as StorageBackend & { execute: (config: ExecuteConfig) => Promise<ExecuteReceipt> }

  const env = op.env ?? {}
  // Clamp per-op overrides to instance limits.
  const timeoutMs = Math.min(op.timeoutMs ?? ctx.limits.maxExecuteMs, ctx.limits.maxExecuteMs)
  const maxOutputBytes = Math.min(op.maxOutputBytes ?? ctx.limits.maxOutputBytes, ctx.limits.maxOutputBytes)
  // cwd is VFS-relative absolute path; backend handles VFS→physical mapping.
  const cwd = op.cwd ?? '/'

  let receipt
  try {
    receipt = await sandbox.execute({
      command: op.command,
      args: op.args,
      cwd,
      env,
      ...(ctx.executeConfig?.envBlocklist ? { envBlocklist: ctx.executeConfig.envBlocklist } : {}),
      timeoutMs,
      maxOutputBytes,
      signal: ctx.signal,
      ...(op.outputEncoding ? { outputEncoding: op.outputEncoding } : {}),
    })
  }
  catch (e) {
    const code = getBackendErrorCode(e)
    const meta = getBackendErrorMeta(e)
    const detail = getBackendErrorDetail(e)

    if (code === 'EXEC_FAILED' && meta) {
      // Signal cancellation → ABORTED, not subprocess failure.
      if (ctx.signal.aborted && (meta as { isCanceled?: boolean }).isCanceled) {
        return err(op.id, op.kind, ERR.ABORTED())
      }
      return err(op.id, op.kind, ERR.EXEC_FAILED(meta as Parameters<typeof ERR.EXEC_FAILED>[0]))
    }
    // Cancellation surfaced by the backend mid-execution (FilesystemBackend
    // throws ABORTED when the subprocess is killed via cancelSignal).
    if (code === 'ABORTED') {
      return err(op.id, op.kind, ERR.ABORTED())
    }
    // Executable not found (POSIX spawn failure, exit 127).
    if (code === 'COMMAND_NOT_FOUND') {
      return err(op.id, op.kind, ERR.COMMAND_NOT_FOUND(op.command))
    }
    if (code === 'OUTPUT_TOO_LARGE' && meta) {
      const m = meta as { stdoutBytes: number, maxOutputBytes: number, partialStdout?: string, partialStderr?: string, durationMs?: number }
      return err(
        op.id,
        op.kind,
        ERR.OUTPUT_TOO_LARGE(m.stdoutBytes, m.maxOutputBytes),
        {
          ...(m.partialStdout !== undefined ? { partialStdout: m.partialStdout } : {}),
          ...(m.partialStderr !== undefined ? { partialStderr: m.partialStderr } : {}),
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        },
      )
    }
    if (code === 'INTERNAL_ERROR') {
      return err(op.id, op.kind, ERR.INTERNAL_ERROR(detail ?? 'unknown'))
    }
    if (code === 'INVALID_PATH') {
      return err(op.id, op.kind, ERR.INVALID_PATH(cwd || '<empty>', detail ?? 'invalid path'))
    }
    // Spawn failure (executable not found). Must not leak into the file-op
    // mapping (vfs.ts maps ENOENT → NOT_FOUND), which would misreport a
    // missing executable as a missing path.
    if (code === 'ENOENT') {
      return err(op.id, op.kind, ERR.COMMAND_NOT_FOUND(op.command))
    }
    throw e
  }

  const stdoutBytes = receipt.stdout instanceof Uint8Array
    ? receipt.stdout.byteLength
    : Buffer.byteLength(receipt.stdout, 'utf8')

  const result: ExecuteResult = {
    command: op.command,
    args: op.args ?? [],
    cwd,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    exitCode: receipt.exitCode,
    timedOut: receipt.timedOut,
    wasKilled: receipt.wasKilled,
    truncated: receipt.truncated,
    durationMs: receipt.durationMs,
  }
  const meta: ExecuteMeta = {
    command: op.command,
    args: op.args ?? [],
    cwd,
    durationMs: receipt.durationMs,
    stdoutBytes,
    stderrBytes: Buffer.byteLength(receipt.stderr, 'utf8'),
    exitCode: receipt.exitCode,
    ...(op.scope ? { scope: op.scope } : {}),
    ...(op.affectedPaths ? { affectedPaths: op.affectedPaths } : {}),
  }
  const tokens = receipt.stdout instanceof Uint8Array
    ? estimateBinaryTokens(stdoutBytes)
    : estimateTextTokens(stdoutBytes)

  return { ok: true, data: result, meta, tokens }
}
