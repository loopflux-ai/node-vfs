import type {
  ExecuteConfig,
  ExecuteReceipt,
  FileStat,
  SandboxInfo,
  WriteMode,
  WriteReceipt,
} from '../types.ts'

/** Max bytes for readLines; larger files yield partial results. */
export const READ_LINES_MAX_BYTES = 4 * 1024 * 1024

export type BackendErrorCode
  = | 'INVALID_PATH'
    | 'NOT_FOUND'
    | 'ALREADY_EXISTS'
    | 'NOT_DIRECTORY'
    | 'CONFLICT'
    | 'PATH_TRAVERSAL'
    | 'PERMISSION_DENIED'
    | 'OUTPUT_TOO_LARGE'
    | 'EXEC_FAILED'
    | 'INTERNAL_ERROR'

export interface Line {
  path: string
  number: number
  text: string
  /** Set on the last yielded line when the file exceeds READ_LINES_MAX_BYTES and content after this line was not read. */
  truncated?: boolean
}

/** Pure file I/O. `execute` is intentionally absent — VFS duck-types it at runtime. */
export interface StorageBackend {
  /** Returns null on ENOENT; never throws. */
  stat: (path: string) => Promise<FileStat | null>
  /** Stream-based range read (`end` exclusive). */
  read: (path: string, range?: { start: number, end: number }, signal?: AbortSignal) => AsyncIterable<Uint8Array>
  write: (path: string, data: Uint8Array, mode: WriteMode) => Promise<WriteReceipt>
  /** Remove file or directory (`recursive` required for directories). */
  remove: (path: string, recursive?: boolean) => Promise<{ wasDirectory: boolean, bytesFreed: number }>
  /** Create a directory (recursively, idempotently). */
  mkdir: (path: string) => Promise<{ wasCreated: boolean }>
  listDir: (path: string) => Promise<string[]>
  globFiles: (path: string, pattern: string) => Promise<string[]>
  readLines: (path: string, signal?: AbortSignal) => AsyncIterable<Line>
  dispose?: () => Promise<void>
  /** Returns sandbox metadata for LLM-facing tool descriptions. Optional. */
  describe?: () => SandboxInfo
}

/** Optional sandbox capability — duck-typed by VFS at runtime. */
export interface SandboxCapability {
  execute: (config: ExecuteConfig) => Promise<ExecuteReceipt>
}

export type SandboxBackend = StorageBackend & SandboxCapability
