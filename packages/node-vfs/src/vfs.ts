/**
 * VFS facade — `createVFS(config)` wires validatePath → middleware onion → handler → backend.
 * Exposes 9 ops: read_file / write_file / edit_file / delete_file / mkdir / grep / ls / glob / execute.
 */

import type { ErrSpec } from './errors.ts'
import type {
  DeleteFileOp,
  DeleteFileOpts,
  DeleteMeta,
  DeleteResult,
  EditFileOp,
  EditFileOpts,
  EditResult,
  Encoding,
  ExecuteAllowList,
  ExecuteCommandOpts,
  ExecuteMeta,
  ExecuteOp,
  ExecuteResult,
  ExecutionContext,
  FileContent,
  FileMeta,
  GlobOp,
  GlobOpts,
  GrepMatch,
  GrepMeta,
  GrepOp,
  GrepOpts,
  ListEntry,
  ListMeta,
  LsOp,
  LsOpts,
  MkdirMeta,
  MkdirOp,
  MkdirOpts,
  MkdirResult,
  Op,
  OpData,
  OpFor,
  OpKind,
  OpMeta,
  ReadFileOp,
  ReadFileOpts,
  Result,
  SandboxInfo,
  VFSConfig,
  WriteFileOp,
  WriteFileOpts,
  WriteResult,
} from './types.ts'
import type { VFSDebugger } from './utils/debug.ts'
import { createCacheLayer } from './cache.ts'
import { err, ERR, getBackendErrorCode, getBackendErrorDetail, getBackendErrorMeta } from './errors.ts'
import { dispatch } from './handlers/dispatch.ts'
import { isCommandOp, isQueryOp, OP_KIND } from './handlers/kinds.ts'
import { compose } from './middleware/compose.ts'
import { isHostAbsolutePath, validatePath } from './path.ts'
import { createDefaultDebugger, DEBUG_CATEGORY } from './utils/debug.ts'
import { combineSignals } from './utils/signal.ts'
import { generateOpId } from './utils/tokens.ts'

const DEFAULT_LIMITS = {
  maxFileSize: 10 * 1024 * 1024,
  maxOutputBytes: 1 * 1024 * 1024,
  maxExecuteMs: 60 * 1000,
  maxEditSize: 1 * 1024 * 1024,
}

function buildContext(
  limits: Readonly<ExecutionContext['limits']>,
  instanceSignal: AbortSignal | undefined,
  opSignal: AbortSignal | undefined,
  ctxDebugger: VFSDebugger | undefined,
  executeAllow: ExecuteAllowList | undefined,
): ExecutionContext {
  return {
    signal: combineSignals(instanceSignal, opSignal),
    limits,
    debugger: ctxDebugger,
    ...(executeAllow ? { executeAllow } : {}),
  }
}

function buildReadFileOp(path: string, opts: ReadFileOpts = {}): ReadFileOp {
  return {
    kind: OP_KIND.READ_FILE,
    id: opts.id ?? generateOpId(),
    path,
    ...(opts.range ? { range: opts.range } : {}),
    ...(opts.encoding ? { encoding: opts.encoding as Encoding } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildWriteFileOp(path: string, content: FileContent, opts: WriteFileOpts = {}): WriteFileOp {
  return {
    kind: OP_KIND.WRITE_FILE,
    id: opts.id ?? generateOpId(),
    path,
    content,
    ...(opts.encoding ? { encoding: opts.encoding as Encoding } : {}),
    mode: opts.mode ?? 'overwrite',
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildEditFileOp(path: string, oldText: string, newText: string, opts: EditFileOpts): EditFileOp {
  return {
    kind: OP_KIND.EDIT_FILE,
    id: opts.id ?? generateOpId(),
    path,
    oldText,
    newText,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildDeleteFileOp(path: string, opts: DeleteFileOpts = {}): DeleteFileOp {
  return {
    kind: OP_KIND.DELETE_FILE,
    id: opts.id ?? generateOpId(),
    path,
    ...(opts.recursive ? { recursive: opts.recursive } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildMkdirOp(path: string, opts: MkdirOpts = {}): MkdirOp {
  return {
    kind: OP_KIND.MKDIR,
    id: opts.id ?? generateOpId(),
    path,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildGrepOp(path: string, pattern: string, opts: GrepOpts = {}): GrepOp {
  return {
    kind: OP_KIND.GREP,
    id: opts.id ?? generateOpId(),
    path,
    pattern,
    ...(opts.flags ? { flags: opts.flags } : {}),
    ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildLsOp(path: string, opts: LsOpts = {}): LsOp {
  return {
    kind: OP_KIND.LS,
    id: opts.id ?? generateOpId(),
    path,
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildGlobOp(path: string, pattern: string, opts: GlobOpts = {}): GlobOp {
  return {
    kind: OP_KIND.GLOB,
    id: opts.id ?? generateOpId(),
    path,
    pattern,
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function buildExecuteOp(command: string, opts: ExecuteCommandOpts = {}): ExecuteOp {
  return {
    kind: OP_KIND.EXECUTE,
    id: opts.id ?? generateOpId(),
    command,
    ...(opts.args ? { args: opts.args } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.affectedPaths ? { affectedPaths: opts.affectedPaths } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

const BACKEND_CODE_MAP: Record<string, (path: string) => ErrSpec> = {
  NOT_FOUND: ERR.NOT_FOUND,
  NOT_DIRECTORY: ERR.NOT_DIRECTORY,
  PERMISSION_DENIED: ERR.PERMISSION_DENIED,
  ENOTDIR: ERR.NOT_DIRECTORY,
  ENOENT: ERR.NOT_FOUND,
  EACCES: ERR.PERMISSION_DENIED,
  EPERM: ERR.PERMISSION_DENIED,
}

export function createVFS(config: VFSConfig) {
  const { backend, limits, signal: instanceSignal, debug, debugger: customDebugger } = config

  const resolvedDebugger = customDebugger ?? (debug ? createDefaultDebugger('vfs') : undefined)

  const mergedLimits = { ...DEFAULT_LIMITS, ...limits }
  const resolvedMaxEditSize = Math.min(mergedLimits.maxEditSize, mergedLimits.maxFileSize)

  const frozenLimits = Object.freeze({
    maxFileSize: mergedLimits.maxFileSize,
    maxOutputBytes: mergedLimits.maxOutputBytes,
    maxExecuteMs: mergedLimits.maxExecuteMs,
    maxEditSize: resolvedMaxEditSize,
  }) as Readonly<ExecutionContext['limits']>

  // Cache is a built-in subsystem, not a user middleware. createVFS
  // orchestrates it directly via the CacheLayer interface (lookup/store/
  // invalidate) inside the composed next() callback — outermost user
  // middleware runs first, cache sits just above the handler. Configured via
  // `cache` — disabled with `false`, tuned with an object, default-on when
  // omitted.
  const userMiddleware = config.middleware ?? []
  const cache = config.cache === false
    ? null
    : createCacheLayer(config.cache === true ? {} : (config.cache ?? {}))
  const composed = compose(userMiddleware)

  async function executeOp<K extends OpKind>(op: OpFor<K>): Promise<Result<OpData<K>, OpMeta<K>>> {
    // Always copy so normalising path/cwd never mutates the caller's op.
    const opWithId: Op = { ...op, id: op.id ?? generateOpId() }

    if ('path' in opWithId) {
      const path = (opWithId as { path: string }).path
      const v = validatePath(path)
      if (!v.ok) {
        const spec = v.code === 'PATH_TRAVERSAL' ? ERR.PATH_TRAVERSAL(path) : ERR.INVALID_PATH(path, 'reject ".." traversal, NUL, and backslashes in virtual paths')
        return err(opWithId.id, opWithId.kind, spec) as Result<OpData<K>, OpMeta<K>>
      }
      ;(opWithId as { path: string }).path = v.normalized
    }
    else if (opWithId.kind === OP_KIND.EXECUTE) {
      const cwd = (opWithId as { cwd?: string }).cwd ?? '/'
      const v = validatePath(cwd)
      if (!v.ok) {
        const spec = v.code === 'PATH_TRAVERSAL' ? ERR.PATH_TRAVERSAL(cwd) : ERR.INVALID_PATH(cwd, 'invalid working directory')
        return err(opWithId.id, opWithId.kind, spec) as Result<OpData<K>, OpMeta<K>>
      }
      ;(opWithId as { cwd?: string }).cwd = v.normalized

      // Declared affected paths obey the same sandbox/traversal rules as
      // file ops — they must not escape the virtual root.
      const affected = (opWithId as { affectedPaths?: string[] }).affectedPaths
      if (affected) {
        const normalizedPaths: string[] = []
        for (const p of affected) {
          const av = validatePath(p)
          if (!av.ok) {
            const spec = av.code === 'PATH_TRAVERSAL' ? ERR.PATH_TRAVERSAL(p) : ERR.INVALID_PATH(p, 'invalid affected path')
            return err(opWithId.id, opWithId.kind, spec) as Result<OpData<K>, OpMeta<K>>
          }
          normalizedPaths.push(av.normalized)
        }
        ;(opWithId as { affectedPaths?: string[] }).affectedPaths = normalizedPaths
      }
    }

    const ctx = buildContext(frozenLimits, instanceSignal, (opWithId as { signal?: AbortSignal }).signal, resolvedDebugger, config.execute)

    resolvedDebugger?.debug(DEBUG_CATEGORY.OP, `${opWithId.kind}`, {
      ...('path' in opWithId ? { path: (opWithId as { path: string }).path } : {}),
      ...(opWithId.kind === OP_KIND.EXECUTE ? { command: (opWithId as { command: string }).command, cwd: (opWithId as { cwd?: string }).cwd ?? '/' } : {}),
      opId: opWithId.id,
    })

    const combinedSignal = ctx.signal as AbortSignal & { __cleanupCombineSignals?: () => void }
    let signalCleanedUp = false
    const signalCleanup = (): void => {
      if (signalCleanedUp)
        return
      signalCleanedUp = true
      combinedSignal.__cleanupCombineSignals?.()
    }

    try {
      const result = await composed(ctx, opWithId as Op, async () => {
        if (cache && isQueryOp(opWithId)) {
          const hit = cache.lookup(opWithId, ctx)
          if (hit)
            return hit
        }
        const handlerResult = (await dispatch(backend, opWithId as Op, ctx)) as Result<unknown, unknown>
        if (cache && handlerResult.ok) {
          if (isQueryOp(opWithId))
            return await cache.store(opWithId, handlerResult, ctx)
          if (isCommandOp(opWithId))
            cache.invalidate(opWithId, ctx)
        }
        return handlerResult
      })
      if (
        result.ok
        && typeof combinedSignal.__cleanupCombineSignals === 'function'
        && isAsyncIterable(result.data)
      ) {
        const stream = result.data as AsyncIterable<unknown>
        const wrapped: AsyncIterable<unknown> = {
          async* [Symbol.asyncIterator]() {
            try {
              yield* stream
            }
            finally {
              // Releasing the combine-signal listeners is deferred until the
              // lazy stream is consumed (break/return/throw included). A
              // caller that never iterates the stream leaves the listeners
              // attached to the instance and per-op signals until those
              // sources themselves are released — consume lazy streams.
              signalCleanup()
            }
          },
        }
        return { ...result, data: wrapped } as Result<OpData<K>, OpMeta<K>>
      }
      signalCleanup()
      resolvedDebugger?.debug(DEBUG_CATEGORY.OP, `${opWithId.kind} ${result.ok ? 'ok' : 'err'}`, { opId: opWithId.id, code: result.ok ? undefined : (result as { code?: string }).code })
      return result as Result<OpData<K>, OpMeta<K>>
    }
    catch (e) {
      signalCleanup()
      resolvedDebugger?.debug(DEBUG_CATEGORY.OP, `${opWithId.kind} error`, { opId: opWithId.id, error: (e as Error).message })
      if (combinedSignal.aborted) {
        return err(opWithId.id, opWithId.kind, ERR.ABORTED()) as Result<OpData<K>, OpMeta<K>>
      }

      const backendCode = getBackendErrorCode(e)
      const opPath = 'path' in opWithId
        ? (opWithId as { path: string }).path
        : opWithId.kind === OP_KIND.EXECUTE
          ? (opWithId as { cwd?: string }).cwd ?? '/'
          : '<unknown>'

      if (backendCode === 'PATH_TRAVERSAL') {
        const meta = getBackendErrorMeta(e)
        const traversePath = (meta && typeof meta.cwd === 'string') ? meta.cwd : opPath
        // Host paths without '..' reach the backend and are rejected by
        // virtualMode — a different cause than '..' traversal (which
        // validatePath catches before dispatch). Distinguish here so the
        // error message and suggestions match the actual cause.
        const cause = isHostAbsolutePath(traversePath) ? 'host-path' : undefined
        return err(opWithId.id, opWithId.kind, ERR.PATH_TRAVERSAL(traversePath, cause)) as Result<OpData<K>, OpMeta<K>>
      }
      if (backendCode === 'INVALID_PATH') {
        return err(opWithId.id, opWithId.kind, ERR.INVALID_PATH(opPath, getBackendErrorDetail(e) ?? 'invalid path')) as Result<OpData<K>, OpMeta<K>>
      }

      const canonical = backendCode ? BACKEND_CODE_MAP[backendCode] : undefined
      if (canonical) {
        return err(opWithId.id, opWithId.kind, canonical(opPath)) as Result<OpData<K>, OpMeta<K>>
      }

      return err(opWithId.id, opWithId.kind, ERR.INTERNAL_ERROR(getBackendErrorDetail(e) ?? 'An unexpected error occurred')) as Result<OpData<K>, OpMeta<K>>
    }
  }

  async function read_file(
    path: string,
    opts?: ReadFileOpts,
  ): Promise<Result<AsyncIterable<Uint8Array>, FileMeta>> {
    return (await executeOp(buildReadFileOp(path, opts))) as Result<AsyncIterable<Uint8Array>, FileMeta>
  }

  async function write_file(
    path: string,
    content: FileContent,
    opts?: WriteFileOpts,
  ): Promise<Result<WriteResult>> {
    return (await executeOp(buildWriteFileOp(path, content, opts))) as Result<WriteResult>
  }

  async function edit_file(
    path: string,
    oldText: string,
    newText: string,
    opts?: EditFileOpts,
  ): Promise<Result<EditResult>> {
    return (await executeOp(buildEditFileOp(path, oldText, newText, opts ?? {}))) as Result<EditResult>
  }

  async function delete_file(
    path: string,
    opts?: DeleteFileOpts,
  ): Promise<Result<DeleteResult, DeleteMeta>> {
    return (await executeOp(buildDeleteFileOp(path, opts))) as Result<DeleteResult, DeleteMeta>
  }

  async function mkdir(
    path: string,
    opts?: MkdirOpts,
  ): Promise<Result<MkdirResult, MkdirMeta>> {
    return (await executeOp(buildMkdirOp(path, opts))) as Result<MkdirResult, MkdirMeta>
  }

  async function grep(
    path: string,
    pattern: string,
    opts?: GrepOpts,
  ): Promise<Result<AsyncIterable<GrepMatch>, GrepMeta>> {
    return (await executeOp(buildGrepOp(path, pattern, opts))) as Result<AsyncIterable<GrepMatch>, GrepMeta>
  }

  async function ls(
    path: string,
    opts?: LsOpts,
  ): Promise<Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>> {
    return (await executeOp(buildLsOp(path, opts))) as Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>
  }

  async function glob(
    path: string,
    pattern: string,
    opts?: GlobOpts,
  ): Promise<Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>> {
    return (await executeOp(buildGlobOp(path, pattern, opts))) as Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>
  }

  function execute(op: ExecuteOp): Promise<Result<ExecuteResult, ExecuteMeta>>
  function execute(command: string, opts?: ExecuteCommandOpts): Promise<Result<ExecuteResult, ExecuteMeta>>
  async function execute(arg1: ExecuteOp | string, arg2?: ExecuteCommandOpts): Promise<Result<ExecuteResult, ExecuteMeta>> {
    if (typeof arg1 === 'string') {
      return (await executeOp(buildExecuteOp(arg1, arg2 ?? {}))) as Result<ExecuteResult, ExecuteMeta>
    }
    // The op-object overload is execute-only. Passing another kind would
    // bypass the named facade methods (read_file, write_file, …) — reject it.
    if (arg1.kind !== OP_KIND.EXECUTE) {
      return err(arg1.id, arg1.kind as OpKind, ERR.UNSUPPORTED(), {
        hint: 'vfs.execute(op) only accepts execute ops — use the dedicated facade methods for other kinds',
      })
    }
    return (await executeOp(arg1)) as Result<ExecuteResult, ExecuteMeta>
  }

  async function dispose(): Promise<void> {
    await backend.dispose?.()
  }

  function describe(): SandboxInfo | undefined {
    return backend.describe?.()
  }

  return {
    execute,
    read_file,
    write_file,
    edit_file,
    delete_file,
    mkdir,
    grep,
    ls,
    glob,
    limits: frozenLimits,
    describe,
    dispose,
  }
}
