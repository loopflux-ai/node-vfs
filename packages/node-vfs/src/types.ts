import type { StorageBackend } from './backend/storage.ts'
import type { OP_KIND } from './handlers/kinds.ts'
import type { Middleware } from './middleware/compose.ts'
import type { VFSDebugger } from './utils/debug.ts'

export interface OkResult<T, M = Record<string, unknown>> {
  ok: true
  data: T
  meta: M
  tokens: number
}

export interface ErrResult {
  ok: false
  code: string
  error: string
  suggestions: readonly string[]
  opId: string
  kind: OpKind
  meta?: Record<string, unknown>
}

export type Result<T, M = Record<string, unknown>> = OkResult<T, M> | ErrResult

export type WriteMode = 'overwrite' | 'create' | 'append'
export type Encoding = 'utf8' | 'base64' | 'hex'
export type FileContent = string | Uint8Array

export interface WriteReceipt {
  bytesWritten: number
  deltaBytes: number
  mode: WriteMode
}

export interface FileStat {
  size: number
  isDirectory: boolean
  mtimeMs: number
}

export interface FileMeta extends FileStat {
  encoding: Encoding
  range?: { start: number, end: number }
  bytesReturned: number
  /** True when the stream was cut short by signal.aborted. */
  truncated: boolean
}

export interface WriteResult {
  path: string
  bytesWritten: number
  deltaBytes: number
  mode: WriteMode
  encoding?: Encoding
}

export interface WriteMeta {
  bytesWritten: number
  deltaBytes: number
}

export interface EditResult {
  path: string
  occurrences: number
  bytesWritten: number
}

export interface EditMeta {
  occurrences: number
  bytesWritten: number
}

export interface DeleteResult {
  path: string
  recursive: boolean
}

export interface DeleteMeta {
  path: string
  recursive: boolean
  wasDirectory: boolean
  bytesFreed: number
}

export interface MkdirResult {
  path: string
  /** False when the directory already existed (idempotent success). */
  wasCreated: boolean
}

export interface MkdirMeta {
  path: string
  wasCreated: boolean
}

export interface ListEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface ListMeta {
  path: string
  truncated: boolean
}

export interface GrepMatch {
  path: string
  lineNumber: number
  text: string
}

export interface GrepMeta {
  pattern: string
  flags: string
  filesSearched: number
  filesTotal: number
  bytesRead: number
  matchCount: number
  truncated: boolean
  truncateReason: 'maxResults' | 'fileSize' | null
}

export interface ExecuteConfig {
  command: string
  args?: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
  /**
   * Explicit output encoding (TextDecoder label, e.g. 'gbk'). When omitted,
   * the backend auto-detects: strict UTF-8 first, then the system ANSI code
   * page (Windows).
   */
  outputEncoding?: string
}

export interface ExecuteReceipt {
  stdout: string | Uint8Array
  stderr: string
  exitCode: number
  timedOut: boolean
  wasKilled: boolean
  truncated: boolean
  durationMs: number
}

export interface ExecuteResult {
  command: string
  args: string[]
  cwd: string
  stdout: string | Uint8Array
  stderr: string
  exitCode: number
  timedOut: boolean
  wasKilled: boolean
  truncated: boolean
  durationMs: number
}

export interface ExecuteMeta {
  command: string
  args: string[]
  cwd: string
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  exitCode: number
  /** Declared access scope (readonly default / readwrite), for audit. */
  scope?: 'readonly' | 'readwrite'
  /** Declared affected virtual paths, for audit. */
  affectedPaths?: string[]
}

export interface BaseOp {
  id: string
  /** AND-ed with the VFS instance signal. */
  signal?: AbortSignal
}

export interface PathOp extends BaseOp {
  path: string
}

export interface ReadFileOp extends PathOp {
  kind: typeof OP_KIND.READ_FILE
  range?: { start: number, end: number }
  encoding?: Encoding
}

export interface WriteFileOp extends PathOp {
  kind: typeof OP_KIND.WRITE_FILE
  content: FileContent
  encoding?: Encoding
  mode: WriteMode
  idempotencyKey?: string
}

export interface EditFileOp extends PathOp {
  kind: typeof OP_KIND.EDIT_FILE
  oldText: string
  newText: string
}

export interface DeleteFileOp extends PathOp {
  kind: typeof OP_KIND.DELETE_FILE
  recursive?: boolean
}

export interface MkdirOp extends PathOp {
  kind: typeof OP_KIND.MKDIR
}

export interface GrepOp extends PathOp {
  kind: typeof OP_KIND.GREP
  pattern: string
  flags?: string
  maxResults?: number
}

export interface LsOp extends PathOp {
  kind: typeof OP_KIND.LS
  cursor?: string
  limit?: number
}

export interface GlobOp extends PathOp {
  kind: typeof OP_KIND.GLOB
  pattern: string
  cursor?: string
  limit?: number
}

export interface ExecuteOp extends BaseOp {
  kind: typeof OP_KIND.EXECUTE
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  /** Explicit output encoding (TextDecoder label, e.g. 'gbk'); auto-detected when omitted. */
  outputEncoding?: string
  /**
   * Declared access scope (default readonly).
   * NOTE: this is a declarative/audit field, NOT an enforcement boundary —
   * the built-in execute guard is the actual enforcement layer.
   */
  scope?: 'readonly' | 'readwrite'
  /**
   * Declared virtual paths this command may modify.
   * NOTE: an honesty-based signal — validated against policy deny rules and
   * sandbox traversal, but a caller may omit it. Real enforcement comes from
   * the execute guard and the policy deny-list.
   */
  affectedPaths?: string[]
}

export interface OpRegistry {
  [OP_KIND.READ_FILE]: { op: ReadFileOp, data: AsyncIterable<Uint8Array>, meta: FileMeta }
  [OP_KIND.WRITE_FILE]: { op: WriteFileOp, data: WriteResult, meta: WriteMeta }
  [OP_KIND.EDIT_FILE]: { op: EditFileOp, data: EditResult, meta: EditMeta }
  [OP_KIND.DELETE_FILE]: { op: DeleteFileOp, data: DeleteResult, meta: DeleteMeta }
  [OP_KIND.MKDIR]: { op: MkdirOp, data: MkdirResult, meta: MkdirMeta }
  [OP_KIND.GREP]: { op: GrepOp, data: AsyncIterable<GrepMatch>, meta: GrepMeta }
  [OP_KIND.LS]: { op: LsOp, data: { entries: ListEntry[], nextCursor?: string }, meta: ListMeta }
  [OP_KIND.GLOB]: { op: GlobOp, data: { entries: ListEntry[], nextCursor?: string }, meta: ListMeta }
  [OP_KIND.EXECUTE]: { op: ExecuteOp, data: ExecuteResult, meta: ExecuteMeta }
}

export type OpKind = keyof OpRegistry
export type Op = OpRegistry[OpKind]['op']
export type OpFor<K extends OpKind> = OpRegistry[K]['op']
export type OpData<K extends OpKind> = OpRegistry[K]['data']
export type OpMeta<K extends OpKind> = OpRegistry[K]['meta']

export type QueryOp = ReadFileOp | GrepOp | LsOp | GlobOp
export type CommandOp = WriteFileOp | EditFileOp | DeleteFileOp | MkdirOp | ExecuteOp

/** Execute allow-list entry: an exact command name or a RegExp on the command field. */
export type ExecuteAllowItem = string | RegExp

export type ExecuteAllowList = readonly ExecuteAllowItem[]

export interface ExecutionContext {
  signal: AbortSignal
  limits: { maxFileSize: number, maxOutputBytes: number, maxExecuteMs: number, maxEditSize: number }
  debugger?: VFSDebugger
  /** Execute allow-list; undefined ⇒ execute disabled (default-deny). */
  executeAllow?: ExecuteAllowList
}

export interface Limits {
  maxFileSize: number
  maxOutputBytes: number
  maxExecuteMs: number
  /** @default 1 MiB */
  maxEditSize?: number
}

/** Sandbox metadata exposed to the LLM via tool descriptions. */
export interface SandboxInfo {
  /** Resolved absolute path of the sandbox root, if the backend has one. */
  rootDir?: string
  /** True when host absolute paths are rejected (virtualMode). */
  virtualMode?: boolean
}

/** Options for the built-in cache subsystem (see `VFSConfig.cache`). */
export interface CacheOptions {
  maxEntries?: number
  maxValueBytes?: number
  maxAgeMs?: Record<string, number>
}

export interface VFSConfig {
  backend: StorageBackend
  middleware?: Middleware[]
  limits?: Partial<Limits>
  /** Instance-wide AbortSignal, AND-ed with per-op signals. */
  signal?: AbortSignal
  debug?: boolean
  debugger?: VFSDebugger
  /**
   * Execute allow-list (default-deny): commands are rejected unless their
   * basename or the command field matches one of these entries (command names
   * or RegExps). Undefined/empty ⇒ every execute op is rejected.
   */
  execute?: ExecuteAllowList
  /**
   * Built-in cache subsystem, appended innermost by createVFS (outermost user
   * middleware runs first, cache sits just above the handler). Default-on.
   * - `true` / omitted → default LRU (256 entries, 64 MiB, TTL per op kind).
   * - `{ ... }` → tuned LRU.
   * - `false` → disabled. read_file returns a lazy stream whose backend
   *   errors (EACCES, ENOENT mid-read, …) surface during consumption, not at
   *   the call site; grep/ls/glob eagerly materialise inside the handler and
   *   are unaffected.
   */
  cache?: CacheOptions | boolean
}

export interface ReadFileOpts {
  range?: { start: number, end: number }
  encoding?: Encoding
  id?: string
  signal?: AbortSignal
}

export interface WriteFileOpts {
  encoding?: Encoding
  mode?: WriteMode
  idempotencyKey?: string
  id?: string
  signal?: AbortSignal
}

export interface EditFileOpts {
  id?: string
  signal?: AbortSignal
}

export interface DeleteFileOpts {
  recursive?: boolean
  id?: string
  signal?: AbortSignal
}

export interface MkdirOpts {
  id?: string
  signal?: AbortSignal
}

export interface GrepOpts {
  flags?: string
  maxResults?: number
  id?: string
  signal?: AbortSignal
}

export interface LsOpts {
  cursor?: string
  limit?: number
  id?: string
  signal?: AbortSignal
}

export interface GlobOpts {
  cursor?: string
  limit?: number
  id?: string
  signal?: AbortSignal
}

export interface ExecuteCommandOpts {
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  /** Explicit output encoding (TextDecoder label, e.g. 'gbk'); auto-detected when omitted. */
  outputEncoding?: string
  /** Declared access scope — audit field only, enforcement lives in the execute guard. */
  scope?: 'readonly' | 'readwrite'
  /** Declared affected virtual paths — honesty-based signal, validated against policy/validatePath. */
  affectedPaths?: string[]
  id?: string
  signal?: AbortSignal
}

export {}
