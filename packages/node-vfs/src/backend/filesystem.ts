/**
 * FilesystemBackend — disk-backed storage with atomic writes (tmp write → rename).
 * `execute` is a concrete method detected via duck-typing (not on StorageBackend).
 */

import type { Dirent, Stats } from 'node:fs'
import type {
  ExecuteConfig,
  ExecuteReceipt,
  FileStat,
  SandboxInfo,
  WriteMode,
  WriteReceipt,
} from '../types.ts'
import type { Line, StorageBackend } from './storage.ts'
import { Buffer } from 'node:buffer'
import {
  createWriteStream,
  promises as fsp,
} from 'node:fs'
import process from 'node:process'
import { execa } from 'execa'
import fastGlob from 'fast-glob'
import { dirname, join, normalize, resolve as pathResolve } from 'pathe'
import { hasTraversalSegments, INTERNAL_GLOB_IGNORE, isHostAbsolutePath, isInternalFileName } from '../path.ts'
import { buildSafeEnv } from '../utils/env.ts'
import { withMutex } from '../utils/mutex.ts'

export class FilesystemBackendError extends Error {
  readonly code: string
  readonly detail?: string
  readonly meta?: Record<string, unknown>

  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message)
    this.name = 'FilesystemBackendError'
    this.code = code
    this.detail = message
    this.meta = meta
  }
}

/** True when `e` is an OS permission error (EACCES/EPERM) → surfaces as PERMISSION_DENIED. */
function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM'
}

function assertInsideRoot(physical: string, root: string): void {
  const normalizedRoot = normalize(root)
  const normalizedPhysical = normalize(physical)
  if (normalizedPhysical === normalizedRoot)
    return
  // Root boundary is root itself, or root + separator. A root like `C:/` or `/`
  // already ends with a separator — appending another one (`C://`) would break
  // the prefix match and wrongly reject every child path.
  const boundary = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  if (normalizedPhysical.startsWith(boundary))
    return
  throw new FilesystemBackendError('PATH_TRAVERSAL', `Path escapes sandbox root: ${physical}`)
}

/**
 * Resolve a VFS path to a physical path.
 *
 * - Host absolute path (`C:/foo`): bypasses `rootDir` and returns the path as-is.
 *   In `virtualMode` such paths are rejected as escapes.
 * - Virtual (`/foo`) and relative (`foo/bar`) paths: resolved under `root`,
 *   with symlink escape detection along the deepest existing component.
 */
async function resolve(vfsPath: string, root: string, virtualMode: boolean): Promise<string> {
  if (isHostAbsolutePath(vfsPath)) {
    if (virtualMode) {
      throw new FilesystemBackendError('PATH_TRAVERSAL', `Path escapes sandbox root: ${vfsPath}`)
    }
    return vfsPath
  }
  // Virtual (`/foo`) or relative (`foo/bar`) path → resolved under root.
  const relative = vfsPath.startsWith('/') ? vfsPath.slice(1) : vfsPath
  const physical = relative ? join(root, relative) : root
  // Walk from the deepest existing component upward.
  let probe = physical
  while (probe !== root && probe !== dirname(probe)) {
    try {
      const stat = await fsp.lstat(probe)
      // For symlinks, resolve the target and verify it's inside root.
      if (stat.isSymbolicLink()) {
        const real = normalize(await fsp.realpath(probe))
        assertInsideRoot(real, root)
      }
      break
    }
    catch (e) {
      // Already a structured backend error (e.g. assertInsideRoot → PATH_TRAVERSAL) — rethrow as-is.
      if (e instanceof FilesystemBackendError)
        throw e
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        if (isPermissionError(e)) {
          throw new FilesystemBackendError('PERMISSION_DENIED', `Permission denied: ${(e as Error).message}`)
        }
        throw new FilesystemBackendError('INTERNAL_ERROR', `stat failed for ${probe}: ${(e as Error).message}`)
      }
    }
    probe = dirname(probe)
  }
  // `probe` is the deepest existing component (or root).
  if (probe !== physical) {
    const real = normalize(await fsp.realpath(probe))
    assertInsideRoot(real, root)
  }
  // Defense in depth: even a fully-existing path must stay inside root. This
  // catches callers that bypass validatePath (e.g. `..` segments passed
  // directly to the backend), which the symlink walk above would otherwise
  // let through when every component exists and is a plain directory.
  assertInsideRoot(physical, root)
  return physical
}

/** Resolve VFS cwd to physical path, resolving symlinks. Host paths bypass rootDir. */
async function resolveCwdInner(vfsCwd: string, root: string, virtualMode: boolean): Promise<string> {
  const physical = await resolve(vfsCwd, root, virtualMode)
  try {
    const real = normalize(await fsp.realpath(physical))
    if (!isHostAbsolutePath(vfsCwd)) {
      assertInsideRoot(real, root)
    }
    return real
  }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new FilesystemBackendError('NOT_FOUND', `Working directory does not exist: ${vfsCwd}`)
    }
    throw e
  }
}

export interface FilesystemBackendOptions {
  /** Required. Relative paths resolve against the current working directory. */
  rootDir: string
  /**
   * Virtual path mode. Default `false`.
   * - `false`: relative paths resolve under `rootDir`; host absolute paths
   *   (e.g. `C:/foo`) bypass `rootDir` and use the real host path.
   * - `true`: every path is treated as a virtual path under `rootDir`; any
   *   attempt to access a path outside `rootDir` is rejected.
   */
  virtualMode?: boolean
}

export class FilesystemBackend implements StorageBackend {
  private readonly root: string
  private readonly virtualMode: boolean
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(options: FilesystemBackendOptions) {
    if (!options.rootDir || typeof options.rootDir !== 'string') {
      throw new TypeError('FilesystemBackend: rootDir is required')
    }
    this.root = pathResolve(options.rootDir)
    this.virtualMode = options.virtualMode ?? false
  }

  async stat(path: string): Promise<FileStat | null> {
    const physical = await resolve(path, this.root, this.virtualMode)
    try {
      const s = await fsp.stat(physical)
      return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT')
        return null
      if (isPermissionError(e)) {
        throw new FilesystemBackendError('PERMISSION_DENIED', `Permission denied: ${(e as Error).message}`)
      }
      throw new FilesystemBackendError('INTERNAL_ERROR', `stat failed: ${(e as Error).message}`)
    }
  }

  async* read(path: string, range?: { start: number, end: number }, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const physical = await resolve(path, this.root, this.virtualMode)
    const handle = await fsp.open(physical, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        throw new FilesystemBackendError('NOT_FOUND', `Not a regular file: ${path}`)
      }
      const start = range?.start ?? 0
      const end = range?.end ?? stat.size
      const length = Math.max(0, end - start)
      if (length === 0)
        return
      const stream = handle.createReadStream({ start, end: end - 1 })
      if (signal) {
        const onAbort = () => stream.destroy()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      for await (const chunk of stream) {
        yield chunk as Uint8Array
      }
    }
    finally {
      await handle.close().catch(() => {})
    }
  }

  async write(path: string, data: Uint8Array, mode: WriteMode): Promise<WriteReceipt> {
    return withMutex(this.locks, `write:${path}`, async () => {
      const physical = await resolve(path, this.root, this.virtualMode)
      await fsp.mkdir(dirname(physical), { recursive: true })

      let prevSize = 0
      try {
        const prevStat = await fsp.stat(physical)
        if (mode === 'create') {
          throw new FilesystemBackendError('ALREADY_EXISTS', `File already exists: ${path}`)
        }
        prevSize = prevStat.size
      }
      catch (e) {
        if (e instanceof FilesystemBackendError)
          throw e
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT')
          throw e
      }

      let receipt: WriteReceipt
      if (mode === 'append' && prevSize > 0) {
        const combined = Buffer.concat([await fsp.readFile(physical), Buffer.from(data)])
        await this.#atomicWrite(physical, combined)
        receipt = { bytesWritten: data.byteLength, deltaBytes: data.byteLength, mode }
      }
      else {
        await this.#atomicWrite(physical, data)
        receipt = { bytesWritten: data.byteLength, deltaBytes: data.byteLength - prevSize, mode }
      }

      return receipt
    })
  }

  async remove(path: string, recursive?: boolean): Promise<{ wasDirectory: boolean, bytesFreed: number }> {
    return withMutex(this.locks, `remove:${path}`, async () => {
      const physical = await resolve(path, this.root, this.virtualMode)
      let stat: Stats
      try {
        stat = await fsp.stat(physical)
      }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT')
          throw new FilesystemBackendError('NOT_FOUND', `Path does not exist: ${path}`)
        throw e
      }
      const wasDirectory = stat.isDirectory()
      if (wasDirectory && !recursive) {
        throw new FilesystemBackendError('INVALID_PATH', `Cannot delete directory without recursive flag: ${path}`)
      }
      let bytesFreed = stat.size
      if (wasDirectory && recursive) {
        // Count the whole subtree so the freed bytes match InMemoryBackend's
        // semantics (sum of contained file sizes). followSymbolicLinks:false
        // keeps the accounting aligned with fsp.rm, which removes the link
        // itself without following it.
        const children = await fastGlob('**/*', {
          cwd: physical,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          stats: true,
          suppressErrors: true,
          ignore: INTERNAL_GLOB_IGNORE,
        })
        bytesFreed = children.reduce((sum, c) => sum + (c.stats?.size ?? 0), 0)
      }
      await fsp.rm(physical, { recursive: wasDirectory, force: true })
      return { wasDirectory, bytesFreed }
    })
  }

  async listDir(path: string): Promise<string[]> {
    const physical = await resolve(path, this.root, this.virtualMode)
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(physical, { withFileTypes: true })
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT')
        throw new FilesystemBackendError('NOT_FOUND', `Directory does not exist: ${path}`)
      if (code === 'ENOTDIR')
        throw new FilesystemBackendError('NOT_DIRECTORY', `Not a directory: ${path}`)
      throw e
    }
    const names: string[] = []
    for (const entry of entries) {
      if (isInternalFileName(entry.name))
        continue
      names.push(entry.name)
    }
    return names
  }

  async globFiles(path: string, pattern: string): Promise<string[]> {
    const physical = await resolve(path, this.root, this.virtualMode)
    const matches = await fastGlob(pattern, {
      cwd: physical,
      dot: true,
      onlyFiles: true,
      suppressErrors: true,
      ignore: INTERNAL_GLOB_IGNORE,
    })
    // Defense in depth: never surface matches that escape the sandbox root
    // (e.g. '..' segments in a pattern). handleGlob rejects such patterns
    // already; this guards other callers (grep) and future entry points.
    return matches.filter(m => !hasTraversalSegments(m)).sort()
  }

  async* readLines(path: string, signal?: AbortSignal): AsyncIterable<Line> {
    const physical = await resolve(path, this.root, this.virtualMode)
    const handle = await fsp.open(physical, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        throw new FilesystemBackendError('NOT_FOUND', `Not a regular file: ${path}`)
      }
      const maxBytes = Math.min(stat.size, 4 * 1024 * 1024)
      const stream = handle.createReadStream({ start: 0, end: maxBytes - 1, encoding: 'utf8' })
      if (signal) {
        const onAbort = () => stream.destroy()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      let lineNumber = 0
      let buffer = ''
      for await (const chunk of stream) {
        buffer += chunk as string
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          lineNumber++
          yield { path, number: lineNumber, text: line }
        }
      }
      if (buffer) {
        lineNumber++
        yield { path, number: lineNumber, text: buffer, truncated: stat.size > maxBytes }
      }
    }
    finally {
      await handle.close().catch(() => {})
    }
  }

  describe(): SandboxInfo {
    return { rootDir: this.root, virtualMode: this.virtualMode }
  }

  async dispose(): Promise<void> {}

  async execute(config: ExecuteConfig): Promise<ExecuteReceipt> {
    const cwd = await resolveCwdInner(config.cwd, this.root, this.virtualMode)
    const safeEnv = buildSafeEnv(config.env)
    const startTime = Date.now()
    try {
      const result = await execa(config.command, config.args ?? [], {
        cwd,
        env: safeEnv,
        timeout: config.timeoutMs,
        maxBuffer: config.maxOutputBytes,
        reject: false,
        cancelSignal: config.signal,
        encoding: 'utf8',
      })

      // Cancellation must surface as ABORTED, not as a normal failed result
      // (exitCode -1 / wasKilled). The VFS handler maps this to ERR.ABORTED.
      if (result.isCanceled) {
        throw new FilesystemBackendError('ABORTED', `Subprocess cancelled: ${config.command}`)
      }
      // POSIX: a failed spawn (executable not found) is reported as exit 127
      // with no output. Windows reports exit 1 with an OS message on stderr
      // that cannot be reliably distinguished from a real exit code — there
      // the exitCode + stderr presentation stays, and the allow-list already
      // narrows the command set.
      if (process.platform !== 'win32' && result.exitCode === 127) {
        throw new FilesystemBackendError('COMMAND_NOT_FOUND', `Command not found: ${config.command}`)
      }

      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8')
      const stderrBytes = Buffer.byteLength(stderr, 'utf8')

      // execa with reject:false silently caps output at maxBuffer. Detect
      // truncation by checking whether stdout+stderr hit the limit so the
      // handler can reflect it in ExecuteReceipt.truncated.
      const truncated = (stdoutBytes + stderrBytes) >= config.maxOutputBytes

      return {
        stdout,
        stderr,
        exitCode: result.exitCode ?? -1,
        timedOut: result.timedOut ?? false,
        wasKilled: result.isCanceled ?? false,
        truncated,
        durationMs: Date.now() - startTime,
      }
    }
    catch (e) {
      // Already a classified backend error (ABORTED / COMMAND_NOT_FOUND) —
      // pass it through; only wrap unexpected execa failures.
      if (e instanceof FilesystemBackendError)
        throw e
      throw new FilesystemBackendError('EXEC_FAILED', `Command failed: ${(e as Error).message}`)
    }
  }

  async #atomicWrite(physical: string, data: Uint8Array): Promise<void> {
    const dir = dirname(physical)
    const tmpName = `.vfs-tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    const tmpPath = join(dir, tmpName)

    try {
      const stream = createWriteStream(tmpPath, { mode: 0o644 })
      await new Promise<void>((resolveStream, rejectStream) => {
        stream.write(data)
        stream.end(() => resolveStream())
        stream.on('error', rejectStream)
      })
      // rename is atomic on the same filesystem: readers observe either the
      // old or the new file, never a partial write. Protocol boundary: this
      // guards against process interruption only, not power loss (no fsync).
      await fsp.rename(tmpPath, physical)
    }
    catch (e) {
      // tmp may be partial — remove it. The target file is untouched unless
      // the rename succeeded; a failed rename atomically leaves it intact.
      await fsp.rm(tmpPath, { force: true }).catch(() => {})
      if (isPermissionError(e)) {
        throw new FilesystemBackendError('PERMISSION_DENIED', `Permission denied: ${(e as Error).message}`)
      }
      throw new FilesystemBackendError('INTERNAL_ERROR', `Atomic write failed: ${(e as Error).message}`)
    }
  }

  async mkdir(path: string): Promise<{ wasCreated: boolean }> {
    const physical = await resolve(path, this.root, this.virtualMode)
    // Stat first: recursive mkdir is a no-op on existing dirs, so we cannot
    // tell "created" from "already exists" afterwards.
    let existing: import('node:fs').Stats | null = null
    try {
      existing = await fsp.stat(physical)
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        if (isPermissionError(e)) {
          throw new FilesystemBackendError('PERMISSION_DENIED', `Permission denied: ${(e as Error).message}`)
        }
        throw new FilesystemBackendError('INTERNAL_ERROR', `stat failed for ${physical}: ${(e as Error).message}`)
      }
    }
    if (existing) {
      if (existing.isDirectory())
        return { wasCreated: false }
      throw new FilesystemBackendError('NOT_DIRECTORY', `Cannot create directory: a file exists at ${path}`)
    }
    await fsp.mkdir(physical, { recursive: true })
    return { wasCreated: true }
  }
}

export {}
