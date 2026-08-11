/** Ephemeral Map-backed storage for testing. No `execute` → VFS returns UNSUPPORTED. */

import type {
  FileStat,
  WriteMode,
  WriteReceipt,
} from '../types.ts'
import type { Line, StorageBackend } from './storage.ts'
import micromatch from 'micromatch'
import { withMutex } from '../utils/mutex.ts'
import { READ_LINES_MAX_BYTES } from './storage.ts'

interface MemoryEntry {
  content: Uint8Array
  mtimeMs: number
}

export class MemoryBackendError extends Error {
  readonly code: string
  readonly detail?: string
  readonly meta?: Record<string, unknown>

  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message)
    this.name = 'MemoryBackendError'
    this.code = code
    this.detail = message
    this.meta = meta
  }
}

export class InMemoryBackend implements StorageBackend {
  private readonly files = new Map<string, MemoryEntry>()
  private readonly dirs = new Set<string>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor() {
    this.dirs.add('/')
  }

  async stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(path)
    if (file) {
      return { size: file.content.byteLength, isDirectory: false, mtimeMs: file.mtimeMs }
    }
    if (this.dirs.has(path)) {
      return { size: 0, isDirectory: true, mtimeMs: 0 }
    }
    // Check if path is a prefix of any existing path (implicit directory).
    const prefix = path === '/' ? '/' : `${path}/`
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix))
        return { size: 0, isDirectory: true, mtimeMs: 0 }
    }
    for (const key of this.dirs.keys()) {
      if (key !== path && key.startsWith(prefix))
        return { size: 0, isDirectory: true, mtimeMs: 0 }
    }
    return null
  }

  async* read(path: string, range?: { start: number, end: number }, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const entry = this.files.get(path)
    if (!entry) {
      throw new MemoryBackendError('NOT_FOUND', `File does not exist: ${path}`)
    }
    const start = range?.start ?? 0
    const end = range?.end ?? entry.content.byteLength
    const slice = entry.content.subarray(start, end)
    if (signal?.aborted)
      return
    yield slice
  }

  async write(path: string, data: Uint8Array, mode: WriteMode): Promise<WriteReceipt> {
    return withMutex(this.locks, `write:${path}`, async () => {
      const existing = this.files.get(path)
      if (mode === 'create' && existing) {
        throw new MemoryBackendError('ALREADY_EXISTS', `File already exists: ${path}`)
      }
      const prevSize = existing?.content.byteLength ?? 0
      let finalContent: Uint8Array
      if (mode === 'append' && existing) {
        const combined = new Uint8Array(prevSize + data.byteLength)
        combined.set(existing.content, 0)
        combined.set(data, prevSize)
        finalContent = combined
        this.files.set(path, { content: finalContent, mtimeMs: Date.now() })
        this.#ensureParentDirs(path)
        return { bytesWritten: data.byteLength, deltaBytes: data.byteLength, mode }
      }
      finalContent = data
      this.files.set(path, { content: finalContent, mtimeMs: Date.now() })
      this.#ensureParentDirs(path)
      return { bytesWritten: data.byteLength, deltaBytes: data.byteLength - prevSize, mode }
    })
  }

  async remove(path: string, recursive?: boolean): Promise<{ wasDirectory: boolean, bytesFreed: number }> {
    return withMutex(this.locks, `remove:${path}`, async () => {
      const file = this.files.get(path)
      if (file) {
        this.files.delete(path)
        return { wasDirectory: false, bytesFreed: file.content.byteLength }
      }
      if (this.dirs.has(path) || (await this.stat(path))?.isDirectory) {
        if (!recursive) {
          throw new MemoryBackendError('INVALID_PATH', `Cannot delete directory without recursive flag: ${path}`)
        }
        const prefix = path === '/' ? '/' : `${path}/`
        let bytesFreed = 0
        for (const key of [...this.files.keys()]) {
          if (key.startsWith(prefix)) {
            bytesFreed += this.files.get(key)!.content.byteLength
            this.files.delete(key)
          }
        }
        for (const key of [...this.dirs.keys()]) {
          if (key !== path && key.startsWith(prefix)) {
            this.dirs.delete(key)
          }
        }
        this.dirs.delete(path)
        return { wasDirectory: true, bytesFreed }
      }
      throw new MemoryBackendError('NOT_FOUND', `Path does not exist: ${path}`)
    })
  }

  async mkdir(path: string): Promise<{ wasCreated: boolean }> {
    return withMutex(this.locks, `mkdir:${path}`, async () => {
      const existing = await this.stat(path)
      if (existing?.isDirectory)
        return { wasCreated: false }
      if (existing)
        throw new MemoryBackendError('NOT_DIRECTORY', `Cannot create directory: a file exists at ${path}`)
      this.#ensureParentDirs(path)
      this.dirs.add(path)
      return { wasCreated: true }
    })
  }

  async listDir(path: string): Promise<string[]> {
    const normalized = path === '/' ? '' : path
    const prefix = normalized ? `${normalized}/` : '/'
    const names = new Set<string>()
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length)
        const name = rest.split('/')[0]
        if (name)
          names.add(name)
      }
    }
    for (const key of this.dirs.keys()) {
      if (key.startsWith(prefix) && key !== path) {
        const rest = key.slice(prefix.length)
        const name = rest.split('/')[0]
        if (name)
          names.add(name)
      }
    }
    return [...names].sort()
  }

  async globFiles(path: string, pattern: string): Promise<string[]> {
    const prefix = path === '/' ? '/' : `${path}/`
    const relFiles: string[] = []
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        relFiles.push(key.slice(prefix.length))
      }
    }
    return micromatch(relFiles, pattern, { dot: true }).sort()
  }

  async* readLines(path: string, signal?: AbortSignal): AsyncIterable<Line> {
    const entry = this.files.get(path)
    if (!entry) {
      throw new MemoryBackendError('NOT_FOUND', `File does not exist: ${path}`)
    }
    if (signal?.aborted)
      return

    // Mirror FilesystemBackend behaviour: truncate at READ_LINES_MAX_BYTES
    // so unit tests exercising grep against the memory backend can catch
    // truncation-related issues.
    const maxBytes = Math.min(entry.content.byteLength, READ_LINES_MAX_BYTES)
    const slice = entry.content.subarray(0, maxBytes)
    const text = new TextDecoder().decode(slice)
    const lines = text.split('\n')
    const wasTruncated = entry.content.byteLength > maxBytes

    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1
      yield {
        path,
        number: i + 1,
        text: lines[i],
        ...(isLast && wasTruncated ? { truncated: true } : {}),
      }
    }
  }

  async dispose(): Promise<void> {
    this.files.clear()
    this.dirs.clear()
    this.dirs.add('/')
  }

  #ensureParentDirs(path: string): void {
    const parts = path.split('/').filter(Boolean)
    parts.pop() // remove filename
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      this.dirs.add(current)
    }
  }
}

export {}
