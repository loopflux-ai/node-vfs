/**
 * Built-in cache subsystem. createVFS orchestrates it
 * directly via the CacheLayer interface (lookup/store/invalidate); configured
 * via `VFSConfig.cache`. CQRS: QueryOp caches, CommandOp invalidates on
 * success. LRU + reverse index (path↔keys) for precise ancestor invalidation.
 * Streams are drained before caching so replays don't re-run handlers.
 */

import type {
  CacheOptions,
  CommandOp,
  DeleteFileOp,
  EditFileOp,
  ExecutionContext,
  FileMeta,
  GlobOp,
  GrepMatch,
  GrepMeta,
  GrepOp,
  ListEntry,
  LsOp,
  MkdirOp,
  OkResult,
  Op,
  QueryOp,
  WriteFileOp,
} from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { OP_KIND } from './handlers/kinds.ts'
import { ancestorPaths } from './path.ts'
import { deepFreeze } from './result.ts'
import { arrayToAsyncIterable } from './utils/batch.ts'
import { DEBUG_CATEGORY } from './utils/debug.ts'

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_VALUE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_KEY_LEN = 1024
/** Default TTL per op kind: read_file 30 s, directory/search ops 5 s. */
const DEFAULT_MAX_AGE_MS: Record<string, number> = {
  read_file: 30_000,
  grep: 5_000,
  ls: 5_000,
  glob: 5_000,
}

interface CacheEntry {
  key: string
  result: OkResult<unknown, unknown>
  bytes: number
  createdAt: number
  /** Paths for reverse-indexed invalidation. */
  paths: string[]
}

function serialisedParams(op: QueryOp): string {
  switch (op.kind) {
    case OP_KIND.READ_FILE: {
      const o = op as { range?: { start: number, end: number }, encoding?: string }
      const r = o.range
      return `${r ? `${r.start}-${r.end}` : '-'}|${o.encoding ?? 'utf8'}`
    }
    case OP_KIND.GREP: {
      const o = op as GrepOp
      return `${o.pattern}|${o.flags ?? ''}|${o.maxResults ?? '-'}`
    }
    case OP_KIND.LS: {
      const o = op as LsOp
      return `${o.cursor ?? '-'}|${o.limit ?? '-'}`
    }
    case OP_KIND.GLOB: {
      const o = op as GlobOp
      return `${o.cursor ?? '-'}|${o.pattern}|${o.limit ?? '-'}`
    }
    default: {
      const _exhaustive: never = op
      void _exhaustive
      const kind = (op as { kind: string }).kind
      throw new Error(
        `Cache layer: unhandled query op kind "${kind}". Add a case to serialisedParams() in cache.ts.`,
      )
    }
  }
}

function entryPaths(op: Op): string[] {
  if (!('path' in op))
    return []
  const path = (op as { path: string }).path
  // read_file caches exact path; ls/glob invalidate ancestor chain.
  if (op.kind === OP_KIND.READ_FILE)
    return [path]
  return ancestorPaths(path)
}

function rawKey(op: QueryOp): string {
  const path = 'path' in op ? op.path : ''
  return `${op.kind}\0${path}\0${serialisedParams(op)}`
}

function makeKey(op: QueryOp): string {
  const raw = rawKey(op)
  if (raw.length <= DEFAULT_MAX_KEY_LEN)
    return raw
  const hash = createHash('sha256').update(raw).digest('hex')
  return `hash:${hash}`
}

class ReverseIndex {
  /** path → set of keys that include this path */
  private byPath = new Map<string, Set<string>>()
  /** key → set of paths */
  private keyPaths = new Map<string, Set<string>>()

  add(key: string, paths: string[]): void {
    const set = new Set(paths)
    this.keyPaths.set(key, set)
    for (const p of paths) {
      let s = this.byPath.get(p)
      if (!s) {
        s = new Set()
        this.byPath.set(p, s)
      }
      s.add(key)
    }
  }

  remove(key: string): void {
    const set = this.keyPaths.get(key)
    if (!set)
      return
    for (const p of set) {
      const s = this.byPath.get(p)
      if (s) {
        s.delete(key)
        if (s.size === 0)
          this.byPath.delete(p)
      }
    }
    this.keyPaths.delete(key)
  }

  /** Find all keys whose paths overlap with the given set. */
  overlapping(targets: string[]): Set<string> {
    const out = new Set<string>()
    for (const t of targets) {
      const s = this.byPath.get(t)
      if (s) {
        for (const k of s)
          out.add(k)
      }
    }
    return out
  }
}

async function drainBytes(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  knownSize?: number,
): Promise<{ data: Uint8Array, truncated: boolean }> {
  let truncated = false
  if (knownSize !== undefined && knownSize > 0) {
    const out = new Uint8Array(knownSize)
    let off = 0
    for await (const chunk of stream) {
      if (signal.aborted) {
        truncated = true
        break
      }
      const end = off + chunk.byteLength
      if (end > knownSize) {
        out.set(chunk.subarray(0, knownSize - off), off)
        off = knownSize
        truncated = true
        break
      }
      out.set(chunk, off)
      off = end
    }
    if (off < knownSize) {
      return { data: out.slice(0, off), truncated: true }
    }
    return { data: out, truncated }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    if (signal.aborted) {
      truncated = true
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return { data: out, truncated }
}

async function drainGrepMatches(
  stream: AsyncIterable<GrepMatch>,
  signal: AbortSignal,
): Promise<{ data: GrepMatch[], truncated: boolean }> {
  const out: GrepMatch[] = []
  let truncated = false
  for await (const m of stream) {
    if (signal.aborted) {
      truncated = true
      break
    }
    out.push(m)
  }
  return { data: out, truncated }
}

function replayBytes(bytes: Uint8Array, chunkSize = 64 * 1024): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let off = 0
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (off >= bytes.byteLength) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          const end = Math.min(off + chunkSize, bytes.byteLength)
          const slice = bytes.slice(off, end)
          off = end
          return Promise.resolve({ value: slice, done: false })
        },
      }
    },
  }
}

function isCompleteResult(result: OkResult<unknown, unknown>): boolean {
  const data = result.data as Record<string, unknown> | undefined
  if (data && 'nextCursor' in data && data.nextCursor)
    return false
  if (result.meta && typeof result.meta === 'object' && 'truncated' in (result.meta as Record<string, unknown>)) {
    if ((result.meta as { truncated: boolean }).truncated)
      return false
  }
  return true
}

function isolateMeta(meta: unknown): unknown {
  if (meta === null || typeof meta !== 'object')
    return meta
  return deepFreeze({ ...(meta as Record<string, unknown>) })
}

function isolateData(data: unknown, kind: string): unknown {
  if (kind === OP_KIND.GREP && Array.isArray(data)) {
    return arrayToAsyncIterable(
      (data as GrepMatch[]).map(m => ({ path: m.path, lineNumber: m.lineNumber, text: m.text })),
    )
  }
  if ((kind === OP_KIND.LS || kind === OP_KIND.GLOB) && data !== null && typeof data === 'object' && 'entries' in data) {
    const src = data as { entries: ListEntry[], nextCursor?: string }
    return {
      entries: src.entries.map(e => ({ ...e })),
      ...(src.nextCursor !== undefined ? { nextCursor: src.nextCursor } : {}),
    }
  }
  return data
}

function estimateSize(result: OkResult<unknown, unknown>): number {
  const data = result.data
  let bytes = 0
  if (data instanceof Uint8Array) {
    bytes = data.byteLength
  }
  else if (Array.isArray(data)) {
    bytes = (data as GrepMatch[]).reduce((sum, m) => sum + Buffer.byteLength(m.path, 'utf8') + Buffer.byteLength(m.text, 'utf8') + 24, 0)
  }
  else if (data && typeof data === 'object' && 'entries' in data) {
    const entries = (data as { entries: ListEntry[] }).entries
    bytes = entries.reduce((sum, e) => sum + JSON.stringify(e).length, 0)
  }
  else {
    bytes = JSON.stringify(result).length
  }
  return Math.max(1, bytes)
}

export interface CacheLayer {
  /** Returns a replayable result on cache hit, undefined on miss/expiry. */
  lookup: (op: QueryOp, ctx: ExecutionContext) => OkResult<unknown, unknown> | undefined
  /** Drains streams, stores the result, returns a replayable result. */
  store: (op: QueryOp, result: OkResult<unknown, unknown>, ctx: ExecutionContext) => Promise<OkResult<unknown, unknown>>
  /** Invalidates cache entries affected by a command op. */
  invalidate: (op: CommandOp, ctx: ExecutionContext) => void
}

export function createCacheLayer(options: CacheOptions = {}): CacheLayer {
  const {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxValueBytes = DEFAULT_MAX_VALUE_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  } = options
  const index = new ReverseIndex()

  const lru = new LRUCache<string, CacheEntry>({
    max: maxEntries,
    maxSize: maxValueBytes,
    sizeCalculation: (entry: CacheEntry) => entry.bytes,
    dispose: (_value: CacheEntry, key: string) => {
      index.remove(key)
    },
  })

  function invalidateKeys(keys: Iterable<string>): void {
    const snapshot = Array.from(keys)
    for (const k of snapshot) {
      lru.delete(k)
      index.remove(k)
    }
  }

  function invalidatePaths(paths: string[], ctx: ExecutionContext): void {
    if (paths.length === 0)
      return
    const keys = index.overlapping(paths)
    if (ctx.debugger) {
      ctx.debugger.debug(DEBUG_CATEGORY.CACHE_INVALIDATE, `Invalidating ${keys.size} cache entries`, {
        triggerPaths: paths.slice(0, 5),
        totalTriggerPaths: paths.length,
        keys: Array.from(keys).slice(0, 10),
        totalKeys: keys.size,
      })
    }
    invalidateKeys(keys)
  }

  return {
    lookup(op: QueryOp, ctx: ExecutionContext): OkResult<unknown, unknown> | undefined {
      const key = makeKey(op)
      const cached = lru.get(key)
      if (!cached) {
        if (ctx.debugger) {
          ctx.debugger.debug(DEBUG_CATEGORY.CACHE_MISS, 'Cache miss', {
            kind: op.kind,
            key,
            path: 'path' in op ? op.path : undefined,
          })
        }
        return undefined
      }
      const maxAge = maxAgeMs[op.kind]
      const ttl = maxAge ?? (op.kind === OP_KIND.READ_FILE ? 30_000 : 5_000)
      if (ttl !== -1 && Date.now() - cached.createdAt > ttl) {
        lru.delete(key)
        index.remove(key)
        if (ctx.debugger) {
          ctx.debugger.debug(DEBUG_CATEGORY.CACHE_MISS, 'Cache miss (expired)', {
            kind: op.kind,
            key,
            age: Date.now() - cached.createdAt,
            ttl,
          })
        }
        return undefined
      }
      if (ctx.debugger) {
        ctx.debugger.debug(DEBUG_CATEGORY.CACHE_HIT, 'Cache hit', {
          kind: op.kind,
          key,
          age: Date.now() - cached.createdAt,
          ttl,
          entryBytes: cached.bytes,
          paths: cached.paths.slice(0, 3),
        })
      }
      const stored = cached.result
      let replayedData: unknown = stored.data
      if (op.kind === OP_KIND.READ_FILE && stored.data instanceof Uint8Array) {
        replayedData = replayBytes(stored.data)
      }
      else {
        replayedData = isolateData(stored.data, op.kind)
      }
      return {
        ok: true as const,
        data: replayedData,
        meta: isolateMeta(stored.meta),
        tokens: stored.tokens,
      }
    },

    async store(op: QueryOp, result: OkResult<unknown, unknown>, ctx: ExecutionContext): Promise<OkResult<unknown, unknown>> {
      if (!isCompleteResult(result))
        return result

      const isStream = result.data && typeof (result.data as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
      if (isStream) {
        if (op.kind === OP_KIND.READ_FILE) {
          const fm = result.meta as { bytesReturned?: number, size?: number }
          const estimate = fm.bytesReturned ?? fm.size ?? 0
          if (estimate > maxValueBytes)
            return result
        }
        else if (op.kind === OP_KIND.GREP) {
          const gm = result.meta as { matchCount?: number }
          if ((gm.matchCount ?? 0) * 500 > maxValueBytes)
            return result
        }
      }

      let storedData: unknown = result.data
      if (isStream) {
        // The meta may be deep-frozen when it came from an inner middleware
        // (e.g. a layered cache). Never mutate it in place — copy first.
        if (result.meta && typeof result.meta === 'object') {
          result.meta = { ...(result.meta as Record<string, unknown>) }
        }
        if (op.kind === OP_KIND.READ_FILE) {
          const drained = await drainBytes(
            result.data as AsyncIterable<Uint8Array>,
            ctx.signal,
            (result.meta as { bytesReturned?: number, size?: number }).bytesReturned
            ?? (result.meta as { bytesReturned?: number, size?: number }).size,
          )
          storedData = drained.data
          ;(result.meta as FileMeta).bytesReturned = drained.data.byteLength
          ;(result.meta as FileMeta).truncated = drained.truncated
        }
        else if (op.kind === OP_KIND.GREP) {
          const drained = await drainGrepMatches(result.data as AsyncIterable<GrepMatch>, ctx.signal)
          storedData = drained.data
          ;(result.meta as GrepMeta).matchCount = drained.data.length
          ;(result.meta as GrepMeta).truncated = drained.truncated
        }
      }

      const finalResult: OkResult<unknown, unknown> = { ...result, data: storedData }
      let replayedData: unknown
      if (op.kind === OP_KIND.READ_FILE && storedData instanceof Uint8Array) {
        replayedData = replayBytes(storedData)
      }
      else {
        replayedData = isolateData(storedData, op.kind)
      }
      const cacheReturn: OkResult<unknown, unknown> = {
        ok: true as const,
        data: replayedData,
        meta: isolateMeta(result.meta),
        tokens: result.tokens,
      }
      if (!isCompleteResult(finalResult)) {
        return cacheReturn
      }
      const key = makeKey(op)
      const entry: CacheEntry = {
        key,
        result: finalResult,
        bytes: estimateSize(finalResult),
        createdAt: Date.now(),
        paths: entryPaths(op),
      }
      if (entry.bytes <= maxValueBytes) {
        lru.set(key, entry)
        index.add(key, entry.paths)
      }
      return cacheReturn
    },

    invalidate(op: CommandOp, ctx: ExecutionContext): void {
      if (op.kind === OP_KIND.WRITE_FILE || op.kind === OP_KIND.EDIT_FILE || op.kind === OP_KIND.DELETE_FILE || op.kind === OP_KIND.MKDIR) {
        const path = (op as WriteFileOp | EditFileOp | DeleteFileOp | MkdirOp).path
        invalidatePaths(ancestorPaths(path), ctx)
      }
      else if (op.kind === OP_KIND.EXECUTE) {
        // execute may modify anything — flush entire cache.
        invalidateKeys(Array.from(lru.keys()))
      }
    },
  }
}
