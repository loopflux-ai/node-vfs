import type { LogEntry, LogEntryEnd, LogEntryStart } from '../packages/node-vfs/src/middleware/logging'
/**
 * Middleware tests: Cache, Logging, Policy, Quota.
 */
import type { ExecutionContext, GrepMatch, OkResult, Op, Result } from '../packages/node-vfs/src/types'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryBackend } from '../packages/node-vfs/src/backend/memory'
import { createCacheLayer } from '../packages/node-vfs/src/cache'
import { dispatch } from '../packages/node-vfs/src/handlers/dispatch'
import { isCommandOp, isQueryOp, OP_KIND } from '../packages/node-vfs/src/handlers/kinds'
import { compose } from '../packages/node-vfs/src/middleware/compose'
import { createLoggingMiddleware } from '../packages/node-vfs/src/middleware/logging'
import { createPolicyMiddleware } from '../packages/node-vfs/src/middleware/policy'
import { createQuotaMiddleware } from '../packages/node-vfs/src/middleware/quota'
import { collect, expectErrResult, expectOkResult, makeCtx, readAll } from './helpers'

function makeNext(backend: InMemoryBackend) {
  return (op: Op) => async (): Promise<Result<unknown, unknown>> => {
    return (await dispatch(backend, op, makeCtx())) as Result<unknown, unknown>
  }
}

/**
 * Mirrors the cache orchestration in vfs.ts executeOp's next() callback:
 * lookup → dispatch → store/invalidate. Tests use this to exercise the
 * CacheLayer interface through the same flow the production code uses.
 */
async function runCache(
  cache: ReturnType<typeof createCacheLayer>,
  ctx: ExecutionContext,
  op: Op,
  next: () => Promise<Result<unknown, unknown>>,
): Promise<Result<unknown, unknown>> {
  if (isQueryOp(op)) {
    const hit = cache.lookup(op, ctx)
    if (hit)
      return hit
  }
  const result = await next()
  if (result.ok) {
    if (isQueryOp(op))
      return await cache.store(op, result, ctx)
    if (isCommandOp(op))
      cache.invalidate(op, ctx)
  }
  return result
}

// Middlewares operate on `Result<unknown, unknown>`, so the concrete payload
// shape is only known to the caller — assert it explicitly here.
function expectOkShape<T, M = Record<string, unknown>>(result: Result<unknown, unknown>): OkResult<T, M> {
  return expectOkResult(result) as unknown as OkResult<T, M>
}

const OVERWRITE = 'overwrite'

// ── Cache middleware ───────────────────────────────────────────────────────

describe('cache middleware', () => {
  let backend: InMemoryBackend
  let cache: ReturnType<typeof createCacheLayer>

  beforeEach(async () => {
    backend = new InMemoryBackend()
    cache = createCacheLayer({ maxEntries: 10 })
    await backend.write('/f.txt', new TextEncoder().encode('hello'), OVERWRITE)
  })

  it('should cache read_file results', async () => {
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

    // First call — cache miss.
    const r1 = await runCache(cache, makeCtx(), op, makeNext(backend)(op))
    expectOkResult(r1)

    // Delete backend data to prove we're reading from cache.
    await backend.remove('/f.txt')

    // Second call — should hit cache.
    const r2 = await runCache(cache, makeCtx(), op, makeNext(backend)(op))
    expectOkResult(r2)
  })

  it('should invalidate cache after write_file', async () => {
    const readOp: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

    // Cache read
    await runCache(cache, makeCtx(), readOp, makeNext(backend)(readOp))

    // Write — should invalidate
    const writeOp: Op = { kind: OP_KIND.WRITE_FILE, id: '2', path: '/f.txt', content: 'new', mode: 'overwrite' } as Op
    await runCache(cache, makeCtx(), writeOp, makeNext(backend)(writeOp))

    // Read again — should get new content (cache miss + re-read)
    await backend.remove('/f.txt')
    await backend.write('/f.txt', new TextEncoder().encode('updated'), OVERWRITE)
    const r2 = await runCache(cache, makeCtx(), readOp, makeNext(backend)(readOp))
    const ok = expectOkShape<AsyncIterable<Uint8Array>, { bytesReturned?: number }>(r2)
    expect(ok.meta.bytesReturned).toBe(7) // 'updated'
  })

  it('should invalidate ancestor chain after a nested write', async () => {
    // Cache a glob/ls covering /src; writing /src/new.ts must invalidate it.
    const lsOp: Op = { kind: OP_KIND.LS, id: '1', path: '/src' } as Op
    await backend.write('/src/a.ts', new TextEncoder().encode('a'), OVERWRITE)
    const r1 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    expectOkResult(r1)

    const writeOp: Op = { kind: OP_KIND.WRITE_FILE, id: '2', path: '/src/new.ts', content: 'n', mode: 'overwrite' } as Op
    await runCache(cache, makeCtx(), writeOp, makeNext(backend)(writeOp))

    const r2 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    const ok = expectOkShape<{ entries: Array<{ name: string }> }>(r2)
    expect(ok.data.entries.map(e => e.name)).toContain('new.ts')
  })

  it('should expire cache entries after their TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const ttlCache = createCacheLayer({ maxEntries: 10, maxAgeMs: { read_file: 100 } })
      const readOp: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

      const r1 = await runCache(ttlCache, makeCtx(), readOp, makeNext(backend)(readOp))
      expectOkResult(r1)

      // Remove the backend file: only a cache hit could still succeed.
      await backend.remove('/f.txt')

      // Advance past the 100ms TTL → entry expires → miss → NOT_FOUND.
      vi.setSystemTime(Date.now() + 200)
      const r2 = await runCache(ttlCache, makeCtx(), readOp, makeNext(backend)(readOp))
      expect(expectErrResult(r2).code).toBe('NOT_FOUND')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('should expire non-read_file entries by their op-kind TTL', async () => {
    // TTL is looked up per op-kind via `maxAgeMs[op.kind]`. A config that
    // sets only `ls` must still expire ls entries — the original regression
    // only covered read_file, leaving the per-kind lookup for ls/grep/glob
    // unverified.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const ttlCache = createCacheLayer({ maxEntries: 10, maxAgeMs: { ls: 100 } })
      await backend.write('/dir/a.txt', new TextEncoder().encode('x'), OVERWRITE)
      const lsOp: Op = { kind: OP_KIND.LS, id: '1', path: '/dir' } as Op

      const r1 = await runCache(ttlCache, makeCtx(), lsOp, makeNext(backend)(lsOp))
      const ok1 = expectOkShape<{ entries: Array<{ name: string }> }>(r1)
      expect(ok1.data.entries.map(e => e.name)).toEqual(['a.txt'])

      // Mutate the directory: a stale cache hit would miss 'b.txt'.
      await backend.write('/dir/b.txt', new TextEncoder().encode('y'), OVERWRITE)

      // Advance past the 100ms TTL → entry expires → miss → fresh backend read.
      vi.setSystemTime(Date.now() + 200)
      const r2 = await runCache(ttlCache, makeCtx(), lsOp, makeNext(backend)(lsOp))
      const ok2 = expectOkShape<{ entries: Array<{ name: string }> }>(r2)
      expect(ok2.data.entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt'])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('should not cache paginated results that carry a nextCursor', async () => {
    await backend.write('/f0.txt', new TextEncoder().encode('x'), OVERWRITE)
    await backend.write('/f1.txt', new TextEncoder().encode('y'), OVERWRITE)
    const lsOp: Op = { kind: OP_KIND.LS, id: '1', path: '/', limit: 1 } as Op

    const r1 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    expectOkResult(r1)

    // If this result had been cached, deleting f0 would not change the replay.
    await backend.remove('/f0.txt')
    const r2 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    const ok = expectOkShape<{ entries: Array<{ name: string }> }>(r2)
    expect(ok.data.entries[0]?.name).not.toBe('f0.txt')
  })

  it('should evict oldest entries when maxEntries is reached', async () => {
    // LRU contract: once maxEntries is hit, the least-recently-used entry is
    // dropped. A subsequent read of the evicted path must miss (go to backend),
    // not replay stale bytes. Also covers the dispose hook that cleans the
    // reverse index — if it fails, the evicted key would linger and the next
    // miss could be misrouted.
    const smallCache = createCacheLayer({ maxEntries: 2 })
    await backend.write('/a.txt', new TextEncoder().encode('a'), OVERWRITE)
    await backend.write('/b.txt', new TextEncoder().encode('b'), OVERWRITE)
    await backend.write('/c.txt', new TextEncoder().encode('c'), OVERWRITE)

    const readA: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/a.txt' } as Op
    const readB: Op = { kind: OP_KIND.READ_FILE, id: '2', path: '/b.txt' } as Op
    const readC: Op = { kind: OP_KIND.READ_FILE, id: '3', path: '/c.txt' } as Op

    // Fill cache: /a, /b.
    expectOkResult(await runCache(smallCache, makeCtx(), readA, makeNext(backend)(readA)))
    expectOkResult(await runCache(smallCache, makeCtx(), readB, makeNext(backend)(readB)))
    // Read /c → evicts /a (LRU).
    expectOkResult(await runCache(smallCache, makeCtx(), readC, makeNext(backend)(readC)))

    // Remove the backend file — only a cache hit could still succeed.
    await backend.remove('/a.txt')

    // /a was evicted → miss → backend NOT_FOUND. If LRU had failed to evict
    // (or dispose had misrouted the key), this would return stale 'a' bytes.
    const r = await runCache(smallCache, makeCtx(), readA, makeNext(backend)(readA))
    expect(expectErrResult(r).code).toBe('NOT_FOUND')

    // /b is still cached → hits despite backend removal.
    const rb = expectOkShape<AsyncIterable<Uint8Array>>(await runCache(smallCache, makeCtx(), readB, makeNext(backend)(readB)))
    expect(await readAll(rb.data)).toBe('b')
  })

  it('should not cache files larger than maxValueBytes', async () => {
    // Memory protection contract: a single huge read must not be admitted into
    // the LRU (otherwise one large file evicts everything else). The cache
    // short-circuits at the stream-estimate check and returns without storing.
    const sizedCache = createCacheLayer({ maxEntries: 10, maxValueBytes: 10 })
    await backend.write('/big.txt', new TextEncoder().encode('x'.repeat(100)), OVERWRITE)
    const readOp: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/big.txt' } as Op

    // First read succeeds (passes through to backend).
    expectOkResult(await runCache(sizedCache, makeCtx(), readOp, makeNext(backend)(readOp)))

    // Remove the backend file — if the read had been cached, the second call
    // would still return the 100 bytes. It must miss → NOT_FOUND.
    await backend.remove('/big.txt')
    const r = await runCache(sizedCache, makeCtx(), readOp, makeNext(backend)(readOp))
    expect(expectErrResult(r).code).toBe('NOT_FOUND')
  })

  it('should cache grep results', async () => {
    const grepOp: Op = { kind: OP_KIND.GREP, id: '1', path: '/', pattern: 'hello' } as Op
    const r1 = await runCache(cache, makeCtx(), grepOp, makeNext(backend)(grepOp))
    const ok1 = expectOkResult(r1)
    expect((await collect(ok1.data as AsyncIterable<GrepMatch>)).length).toBe(1)

    // Prove the second call replays from cache, not from the backend.
    await backend.remove('/f.txt')
    const r2 = await runCache(cache, makeCtx(), grepOp, makeNext(backend)(grepOp))
    const ok2 = expectOkResult(r2)
    expect((await collect(ok2.data as AsyncIterable<GrepMatch>)).length).toBe(1)
  })

  it('should flush the entire cache after a successful execute', async () => {
    // InMemoryBackend rejects execute (UNSUPPORTED), so a successful execute
    // must be simulated with a stub — only a successful command can modify
    // arbitrary paths and therefore must flush every cached entry.
    const readOp: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op
    await runCache(cache, makeCtx(), readOp, makeNext(backend)(readOp))

    const execOp: Op = { kind: OP_KIND.EXECUTE, id: '2', command: 'anything' } as Op
    const fakeExecNext = async (): Promise<Result<unknown, unknown>> => ({
      ok: true,
      data: {},
      meta: { stdoutBytes: 0, exitCode: 0 },
      tokens: 0,
    })
    expectOkResult(await runCache(cache, makeCtx(), execOp, fakeExecNext))

    await backend.remove('/f.txt')
    const r2 = await runCache(cache, makeCtx(), readOp, makeNext(backend)(readOp))
    expect(expectErrResult(r2).code).toBe('NOT_FOUND')
  })

  it('should invalidate cache after mkdir', async () => {
    const lsOp: Op = { kind: OP_KIND.LS, id: '1', path: '/', limit: 100 } as Op

    // Cache ls of root (empty directory).
    const r1 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    expectOkResult(r1)

    // mkdir — should invalidate the cached ls.
    const mkdirOp: Op = { kind: OP_KIND.MKDIR, id: '2', path: '/newdir' } as Op
    const m = await runCache(cache, makeCtx(), mkdirOp, makeNext(backend)(mkdirOp))
    expectOkResult(m)

    // ls again — must not come from the stale cache.
    const r2 = await runCache(cache, makeCtx(), lsOp, makeNext(backend)(lsOp))
    const ok = expectOkShape<{ entries: Array<{ name: string }> }>(r2)
    expect(ok.data.entries.some(e => e.name === 'newdir')).toBe(true)
  })

  it('should tolerate a deep-frozen meta from an inner middleware', async () => {
    // Regression: when a user-provided cache is layered over the default one,
    // the inner cache returns a deep-frozen meta. The outer cache used to
    // mutate that meta in place and throw a TypeError.
    const localCache = createCacheLayer({ maxEntries: 10 })
    const stream: AsyncIterable<Uint8Array> = {
      async* [Symbol.asyncIterator]() {
        yield new TextEncoder().encode('hello')
      },
    }
    const fakeNext = async (): Promise<Result<unknown, unknown>> => ({
      ok: true,
      data: stream,
      meta: Object.freeze({ bytesReturned: 5, truncated: false }),
      tokens: 0,
    })
    const readOp: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

    const ok = expectOkResult(await runCache(localCache, makeCtx(), readOp, fakeNext))
    const chunks = await collect(ok.data as AsyncIterable<Uint8Array>)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello')
  })
})

// ── Logging middleware ─────────────────────────────────────────────────────

describe('logging middleware', () => {
  let backend: InMemoryBackend

  beforeEach(async () => {
    backend = new InMemoryBackend()
    await backend.write('/f.txt', new TextEncoder().encode('hello'), OVERWRITE)
  })

  it('should log successful operations with start and end phases', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

    const result = await loggingMw(makeCtx(), op, makeNext(backend)(op))
    expectOkResult(result)
    expect(logs).toHaveLength(2)
    // Start event — no ok/duration fields on this variant.
    expect(logs[0]!.phase).toBe('start')
    expect(logs[0]!.opKind).toBe('read_file')
    expect(logs[0]!.opId).toBe('1')
    expect('ok' in logs[0]!).toBe(false)
    // End event — has result and timing.
    expect(logs[1]!.phase).toBe('end')
    const end = logs[1]! as LogEntryEnd
    expect(end.opKind).toBe('read_file')
    expect(end.ok).toBe(true)
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
    // Non-execute ok ops derive a success status and carry no execute payload.
    expect(end.status).toBe('success')
    expect('execute' in end).toBe(false)
  })

  it('should log failed operations with code on end event', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/noexist' } as Op

    const result = await loggingMw(makeCtx(), op, makeNext(backend)(op))
    expectErrResult(result)
    expect(logs).toHaveLength(2)
    expect(logs[0]!.phase).toBe('start')
    expect('code' in logs[0]!).toBe(false)
    expect(logs[1]!.phase).toBe('end')
    expect((logs[1]! as LogEntryEnd).code).toBe('NOT_FOUND')
  })

  it('should log command for execute ops in both phases', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.EXECUTE, id: '1', command: 'node' } as Op

    await loggingMw(makeCtx(), op, makeNext(backend)(op))
    expect(logs).toHaveLength(2)
    expect(logs[0]!.phase).toBe('start')
    expect((logs[0]! as LogEntryStart).execute?.command).toBe('node')
    expect(logs[1]!.phase).toBe('end')
    const end = logs[1]! as LogEntryEnd
    expect(end.execute?.command).toBe('node')
    // The subprocess never ran (UNSUPPORTED) — exitCode must be absent.
    expect(end.execute?.exitCode).toBeUndefined()
  })

  it('should record bytesReturned from read_file meta on end event', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op

    await loggingMw(makeCtx(), op, makeNext(backend)(op))
    expect('bytes' in logs[0]!).toBe(false)
    expect((logs[1]! as LogEntryEnd).bytes).toBe(5)
  })

  it('should record stdout bytes and exit code from execute meta on end event', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.EXECUTE, id: '1', command: 'cmd' } as Op
    const fakeNext = async (): Promise<Result<unknown, unknown>> => ({
      ok: true,
      data: {},
      meta: { stdoutBytes: 42, exitCode: 3 },
      tokens: 0,
    })

    await loggingMw(makeCtx(), op, fakeNext)
    expect('bytes' in logs[0]!).toBe(false)
    expect('exitCode' in logs[0]!).toBe(false)
    const end = logs[1]! as LogEntryEnd
    expect(end.bytes).toBe(42)
    expect(end.execute?.exitCode).toBe(3)
  })

  it.each([
    {
      name: 'success for a successful execute',
      op: { kind: OP_KIND.EXECUTE, id: '1', command: 'cmd' } as Op,
      fakeNext: async (): Promise<Result<unknown, unknown>> => ({
        ok: true,
        data: { exitCode: 0 },
        meta: { stdoutBytes: 0, exitCode: 0 },
        tokens: 0,
      }),
      expected: 'success',
    },
    {
      name: 'failed when execute exits non-zero',
      op: { kind: OP_KIND.EXECUTE, id: '1', command: 'cmd' } as Op,
      fakeNext: async (): Promise<Result<unknown, unknown>> => ({
        ok: true,
        data: { exitCode: 3 },
        meta: { stdoutBytes: 42, exitCode: 3 },
        tokens: 0,
      }),
      expected: 'failed',
    },
    {
      name: 'cancelled from ABORTED errors',
      op: { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op,
      fakeNext: async (): Promise<Result<unknown, unknown>> => ({
        ok: false,
        code: 'ABORTED',
        error: 'Operation aborted by caller',
        suggestions: [],
        opId: '1',
        kind: OP_KIND.READ_FILE,
      }),
      expected: 'cancelled',
    },
    {
      name: 'rejected from PERMISSION_DENIED errors',
      op: { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op,
      fakeNext: async (): Promise<Result<unknown, unknown>> => ({
        ok: false,
        code: 'PERMISSION_DENIED',
        error: 'Permission denied',
        suggestions: [],
        opId: '1',
        kind: OP_KIND.READ_FILE,
      }),
      expected: 'rejected',
    },
    {
      name: 'error for other failures',
      op: { kind: OP_KIND.READ_FILE, id: '1', path: '/noexist' } as Op,
      fakeNext: async (): Promise<Result<unknown, unknown>> => ({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Path not found',
        suggestions: [],
        opId: '1',
        kind: OP_KIND.READ_FILE,
      }),
      expected: 'error',
    },
  ])('should derive $name status', async ({ op, fakeNext, expected }) => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })

    await loggingMw(makeCtx(), op, fakeNext)
    expect((logs[1]! as LogEntryEnd).status).toBe(expected)
  })

  it('should emit an end event with error status when next() throws', async () => {
    const logs: LogEntry[] = []
    const loggingMw = createLoggingMiddleware({ log: entry => logs.push(entry) })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/f.txt' } as Op
    const throwingNext = async (): Promise<Result<unknown, unknown>> => {
      throw new Error('boom')
    }

    await expect(loggingMw(makeCtx(), op, throwingNext)).rejects.toThrow('boom')
    expect(logs).toHaveLength(2)
    expect(logs[0]!.phase).toBe('start')
    expect(logs[1]!.phase).toBe('end')
    const end = logs[1]! as LogEntryEnd
    expect(end.ok).toBe(false)
    expect(end.code).toBeUndefined()
    expect(end.status).toBe('error')
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ── Policy middleware ──────────────────────────────────────────────────────

describe('policy middleware', () => {
  let backend: InMemoryBackend

  beforeEach(async () => {
    backend = new InMemoryBackend()
    await backend.write('/secret.txt', new TextEncoder().encode('sensitive'), OVERWRITE)
    await backend.write('/public.txt', new TextEncoder().encode('open'), OVERWRITE)
  })

  it('should deny direct access to matching paths', async () => {
    const policyMw = createPolicyMiddleware({ deny: [/\/secret/] })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/secret.txt' } as Op

    const result = await policyMw(makeCtx(), op, makeNext(backend)(op))
    expect(expectErrResult(result).code).toBe('PERMISSION_DENIED')
  })

  it('should allow non-matching paths', async () => {
    const policyMw = createPolicyMiddleware({ deny: [/\/secret/] })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/public.txt' } as Op

    expectOkResult(await policyMw(makeCtx(), op, makeNext(backend)(op)))
  })

  it('should filter denied entries from ls', async () => {
    const policyMw = createPolicyMiddleware({ deny: [/\/secret/] })
    const op: Op = { kind: OP_KIND.LS, id: '1', path: '/' } as Op

    const ok = expectOkShape<{ entries: Array<{ path: string }> }>(await policyMw(makeCtx(), op, makeNext(backend)(op)))
    const paths = ok.data.entries.map(e => e.path)
    expect(paths).not.toContain('/secret.txt')
    expect(paths).toContain('/public.txt')
  })

  it('should filter denied entries from glob', async () => {
    const policyMw = createPolicyMiddleware({ deny: [/\/secret/] })
    const op: Op = { kind: OP_KIND.GLOB, id: '1', path: '/', pattern: '*.txt' } as Op

    const ok = expectOkShape<{ entries: Array<{ path: string }> }>(await policyMw(makeCtx(), op, makeNext(backend)(op)))
    const paths = ok.data.entries.map(e => e.path)
    expect(paths).not.toContain('/secret.txt')
    expect(paths).toContain('/public.txt')
  })

  it('should filter denied entries from grep stream', async () => {
    await backend.write('/secret/file.txt', new TextEncoder().encode('secret\ncontent'), OVERWRITE)
    await backend.write('/open/file.txt', new TextEncoder().encode('open\ncontent'), OVERWRITE)
    const policyMw = createPolicyMiddleware({ deny: [/\/secret/] })
    const op: Op = { kind: OP_KIND.GREP, id: '1', path: '/', pattern: 'content' } as Op

    const ok = expectOkResult(await policyMw(makeCtx(), op, makeNext(backend)(op)))
    const matches = await collect(ok.data as AsyncIterable<{ path: string }>)
    const paths = matches.map(m => m.path)
    expect(paths).not.toContain('/secret/file.txt')
    expect(paths).toContain('/open/file.txt')
  })

  it('should be zero-overhead with an empty deny list', async () => {
    const policyMw = createPolicyMiddleware({ deny: [] })
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/secret.txt' } as Op
    expectOkResult(await policyMw(makeCtx(), op, makeNext(backend)(op)))
  })

  it('should strip global/sticky flags so consecutive matching entries are all filtered', async () => {
    // Regression: with /g, RegExp.test() advances lastIndex after a match,
    // causing the next identical-match entry to slip through the filter.
    const policyMw = createPolicyMiddleware({ deny: [/\.env$/g] })
    await backend.write('/a.env', new TextEncoder().encode('x'), OVERWRITE)
    await backend.write('/b.env', new TextEncoder().encode('y'), OVERWRITE)
    await backend.write('/c.txt', new TextEncoder().encode('z'), OVERWRITE)
    const op: Op = { kind: OP_KIND.LS, id: '1', path: '/' } as Op

    const ok = expectOkShape<{ entries: Array<{ path: string }> }>(await policyMw(makeCtx(), op, makeNext(backend)(op)))
    const paths = ok.data.entries.map(e => e.path)
    expect(paths).not.toContain('/a.env')
    expect(paths).not.toContain('/b.env')
    expect(paths).toContain('/c.txt')
  })

  // Execute command restrictions live in createVFS (default-deny allow-list).
  // This middleware only validates declared affectedPaths against deny.
  describe('execute affectedPaths', () => {
    const fakeExecOk = async (): Promise<Result<unknown, unknown>> => ({
      ok: true,
      data: {},
      meta: {},
      tokens: 0,
    })

    it('should deny execute whose affected paths match the deny list', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const denied: Op = { kind: OP_KIND.EXECUTE, id: '1', command: 'node script.js', affectedPaths: ['/.env'] } as Op
      const r = expectErrResult(await policyMw(makeCtx(), denied, fakeExecOk))
      expect(r.code).toBe('PERMISSION_DENIED')
    })

    it('should allow execute with non-denied affected paths', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const ok: Op = { kind: OP_KIND.EXECUTE, id: '1', command: 'node script.js', affectedPaths: ['/src/out.txt'] } as Op
      expectOkResult(await policyMw(makeCtx(), ok, fakeExecOk))
    })
  })

  // Regression: `/\/\./` used to miss the relative root form ".env" because
  // it has no leading slash — the same file was denied as "/.env" but allowed
  // as ".env". Patterns must match all path representations consistently.
  describe('dotfile deny with relative paths', () => {
    beforeEach(async () => {
      // InMemoryBackend keys are literal (no normalization), so seed files
      // with the same relative form the policy ops below will use.
      await backend.write('.env', new TextEncoder().encode('SECRET'), OVERWRITE)
      await backend.write('.git/config', new TextEncoder().encode('cfg'), OVERWRITE)
      await backend.write('sub/.env', new TextEncoder().encode('inner'), OVERWRITE)
      await backend.write('public.txt', new TextEncoder().encode('ok'), OVERWRITE)
    })

    it('should deny a relative-path read of a dotfile', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '.env' } as Op
      expect(expectErrResult(await policyMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('PERMISSION_DENIED')
    })

    it('should deny a relative-path delete of a dotfile', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.DELETE_FILE, id: '1', path: '.env' } as Op
      expect(expectErrResult(await policyMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('PERMISSION_DENIED')
    })

    it('should deny a relative-path write to a dotfile', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.WRITE_FILE, id: '1', path: '.env', content: 'x', mode: 'overwrite' } as Op
      expect(expectErrResult(await policyMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('PERMISSION_DENIED')
    })

    it('should deny nested relative dotfiles', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: 'sub/.env' } as Op
      expect(expectErrResult(await policyMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('PERMISSION_DENIED')
    })

    it('should still deny the virtual-absolute form', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/.env' } as Op
      expect(expectErrResult(await policyMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('PERMISSION_DENIED')
    })

    it('should allow non-dotfile relative paths', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: 'public.txt' } as Op
      expectOkResult(await policyMw(makeCtx(), op, makeNext(backend)(op)))
    })

    it('should filter dotfiles from a listing of a relative directory', async () => {
      const policyMw = createPolicyMiddleware({ deny: [/\/\./] })
      const op: Op = { kind: OP_KIND.LS, id: '1', path: 'sub' } as Op
      const ok = expectOkShape<{ entries: Array<{ path: string }> }>(await policyMw(makeCtx(), op, makeNext(backend)(op)))
      const paths = ok.data.entries.map(e => e.path)
      expect(paths).not.toContain('sub/.env')
    })
  })
})

// ── Quota middleware ───────────────────────────────────────────────────────

describe('quota middleware', () => {
  let backend: InMemoryBackend

  beforeEach(async () => {
    backend = new InMemoryBackend()
  })

  it('should allow writes within quota', async () => {
    const quotaMw = createQuotaMiddleware({ maxBytes: 100 })
    const op: Op = { kind: OP_KIND.WRITE_FILE, id: '1', path: '/f.txt', content: 'hello', mode: 'overwrite' } as Op

    expectOkResult(await quotaMw(makeCtx(), op, makeNext(backend)(op)))
  })

  it('should reject writes exceeding quota', async () => {
    const quotaMw = createQuotaMiddleware({ maxBytes: 2 })
    const op: Op = { kind: OP_KIND.WRITE_FILE, id: '1', path: '/f.txt', content: 'hello', mode: 'overwrite' } as Op

    expect(expectErrResult(await quotaMw(makeCtx(), op, makeNext(backend)(op))).code).toBe('CAPACITY_EXCEEDED')
  })

  it('should free quota after delete', async () => {
    const quotaMw = createQuotaMiddleware({ maxBytes: 100 })
    const writeOp: Op = { kind: OP_KIND.WRITE_FILE, id: '1', path: '/f.txt', content: 'hello', mode: 'overwrite' } as Op

    // Write — consume quota.
    await quotaMw(makeCtx(), writeOp, makeNext(backend)(writeOp))

    // Delete — free quota.
    const deleteOp: Op = { kind: OP_KIND.DELETE_FILE, id: '2', path: '/f.txt' } as Op
    const delResult = await quotaMw(makeCtx(), deleteOp, makeNext(backend)(deleteOp))
    expectOkResult(delResult)

    // Write again — should be allowed.
    const writeOp2: Op = { kind: OP_KIND.WRITE_FILE, id: '3', path: '/f2.txt', content: 'hello world', mode: 'overwrite' } as Op
    expectOkResult(await quotaMw(makeCtx(), writeOp2, makeNext(backend)(writeOp2)))
  })

  it('should account for edit growth via deltaBytes', async () => {
    const quotaMw = createQuotaMiddleware({ maxBytes: 10 })
    const ctx = makeCtx()

    // Seed the file THROUGH the quota layer so its 5 bytes count toward usedBytes.
    const seedOp: Op = { kind: OP_KIND.WRITE_FILE, id: '0', path: '/f.txt', content: 'hello', mode: 'overwrite' } as Op
    expectOkResult(await quotaMw(ctx, seedOp, makeNext(backend)(seedOp)))

    // "hello" (5) → "hello world" (11) = delta +6 → total 11 > 10 → rejected.
    const editOp: Op = { kind: OP_KIND.EDIT_FILE, id: '1', path: '/f.txt', oldText: 'hello', newText: 'hello world' } as Op
    expect(expectErrResult(await quotaMw(ctx, editOp, makeNext(backend)(editOp))).code).toBe('CAPACITY_EXCEEDED')

    // A shrinking edit (5 → 2, delta -3) frees quota instead of consuming it.
    const shrinkOp: Op = { kind: OP_KIND.EDIT_FILE, id: '2', path: '/f.txt', oldText: 'hello', newText: 'hi' } as Op
    expectOkResult(await quotaMw(ctx, shrinkOp, makeNext(backend)(shrinkOp)))

    // usedBytes is now 2 → an 8-byte write is the exact remaining budget.
    const writeOp: Op = { kind: OP_KIND.WRITE_FILE, id: '3', path: '/g.txt', content: 'abc', mode: 'overwrite' } as Op
    expectOkResult(await quotaMw(ctx, writeOp, makeNext(backend)(writeOp)))

    // 2 + 3 = 5 → a further 6-byte write would exceed the 10-byte budget.
    const writeOp2: Op = { kind: OP_KIND.WRITE_FILE, id: '4', path: '/h.txt', content: 'abcdef', mode: 'overwrite' } as Op
    expect(expectErrResult(await quotaMw(ctx, writeOp2, makeNext(backend)(writeOp2))).code).toBe('CAPACITY_EXCEEDED')
  })

  it('should keep usedBytes consistent under concurrent writes and deletes', async () => {
    // Regression guard: positive-delta writes hold the 'quota:check' mutex,
    // but deletes (and shrinking writes) update usedBytes WITHOUT the lock.
    // JS single-threaded `+=` is atomic, so the final tally must be consistent
    // — no lost updates. This test pins that invariant: if quota ever moves
    // to async check or worker threads, the boundary probes will fail.
    const quotaMw = createQuotaMiddleware({ maxBytes: 1000 })
    const ctx = makeCtx()

    // Seed 5 files of 100 bytes each → usedBytes = 500.
    for (let i = 0; i < 5; i++) {
      const op: Op = { kind: OP_KIND.WRITE_FILE, id: `seed-${i}`, path: `/f${i}.txt`, content: 'x'.repeat(100), mode: 'overwrite' } as Op
      expectOkResult(await quotaMw(ctx, op, makeNext(backend)(op)))
    }

    // Concurrent mix: 5 deletes (release 100 each, no lock) + 5 writes of
    // 50 bytes (positive delta, hold lock). The interleaving across await
    // points is what would expose a race in a non-atomic usedBytes update.
    const deletes = Array.from({ length: 5 }, (_, i) => {
      const op: Op = { kind: OP_KIND.DELETE_FILE, id: `del-${i}`, path: `/f${i}.txt` } as Op
      return quotaMw(ctx, op, makeNext(backend)(op))
    })
    const writes = Array.from({ length: 5 }, (_, i) => {
      const op: Op = { kind: OP_KIND.WRITE_FILE, id: `wr-${i}`, path: `/g${i}.txt`, content: 'y'.repeat(50), mode: 'overwrite' } as Op
      return quotaMw(ctx, op, makeNext(backend)(op))
    })
    const results = await Promise.all([...deletes, ...writes])
    for (const r of results)
      expectOkResult(r)

    // usedBytes should be 500 - 500 + 250 = 250. Probe the boundary:
    // 751 must exceed (250 + 751 = 1001 > 1000), 750 must fit exactly.
    const overOp: Op = { kind: OP_KIND.WRITE_FILE, id: 'over', path: '/over.txt', content: 'z'.repeat(751), mode: 'overwrite' } as Op
    expect(expectErrResult(await quotaMw(ctx, overOp, makeNext(backend)(overOp))).code).toBe('CAPACITY_EXCEEDED')

    const fitOp: Op = { kind: OP_KIND.WRITE_FILE, id: 'fit', path: '/fit.txt', content: 'z'.repeat(750), mode: 'overwrite' } as Op
    expectOkResult(await quotaMw(ctx, fitOp, makeNext(backend)(fitOp)))
  })
})

// ── Compose ────────────────────────────────────────────────────────────────

describe('compose', () => {
  let backend: InMemoryBackend

  beforeEach(() => {
    backend = new InMemoryBackend()
  })

  it('should call middlewares in order', async () => {
    const order: string[] = []
    const m1 = async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => {
      order.push('m1:before')
      const r = await next()
      order.push('m1:after')
      return r
    }
    const m2 = async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => {
      order.push('m2:before')
      const r = await next()
      order.push('m2:after')
      return r
    }
    const composed = compose([m1, m2])
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/' } as Op
    await composed(makeCtx(), op, makeNext(backend)(op))

    expect(order).toEqual(['m1:before', 'm2:before', 'm2:after', 'm1:after'])
  })

  it('should throw on multiple next() calls', async () => {
    const mw = async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => {
      await next()
      await next()
      return { ok: true, data: null, meta: {}, tokens: 0 } as unknown as Result<unknown, unknown>
    }
    const composed = compose([mw])
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/' } as Op
    await expect(composed(makeCtx(), op, makeNext(backend)(op))).rejects.toThrow('next() called multiple times in middleware')
  })

  // Exception propagation contract: compose does NOT swallow errors. A throw
  // from middleware (before next, after next) or from inside next() must reach
  // the caller as a rejection. The vfs facade's try/catch relies on this — if
  // compose ever started catching and converting to ErrResult, the facade's
  // error path would silently change shape.

  it('should propagate exceptions thrown by middleware before next', async () => {
    const mw = async () => {
      throw new Error('before-next-boom')
    }
    const composed = compose([mw])
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/' } as Op
    await expect(composed(makeCtx(), op, makeNext(backend)(op))).rejects.toThrow('before-next-boom')
  })

  it('should propagate exceptions thrown by middleware after next', async () => {
    const mw = async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => {
      await next()
      throw new Error('after-next-boom')
    }
    const composed = compose([mw])
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/' } as Op
    await expect(composed(makeCtx(), op, makeNext(backend)(op))).rejects.toThrow('after-next-boom')
  })

  it('should propagate exceptions thrown inside next', async () => {
    const mw = async (_ctx: ExecutionContext, _op: Op, next: () => Promise<Result<unknown, unknown>>) => {
      return await next()
    }
    const composed = compose([mw])
    const op: Op = { kind: OP_KIND.READ_FILE, id: '1', path: '/' } as Op
    const failingNext = async (): Promise<Result<unknown, unknown>> => {
      throw new Error('next-boom')
    }
    await expect(composed(makeCtx(), op, failingNext)).rejects.toThrow('next-boom')
  })
})
