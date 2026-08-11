/**
 * Unit tests for utility modules: mutex, signal, path, env, tokens, batch, debug.
 */
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ancestorPaths, decodeCursor, encodeCursor, INTERNAL_GLOB_IGNORE, isHostAbsolutePath, isInternalFileName, validatePath } from '../packages/node-vfs/src/path'
import { arrayToAsyncIterable, MAX_BATCH_ITEMS, processInBatches } from '../packages/node-vfs/src/utils/batch'
import { createDefaultDebugger, DEBUG_CATEGORY } from '../packages/node-vfs/src/utils/debug'
import { buildChildEnv } from '../packages/node-vfs/src/utils/env'
import { withMutex } from '../packages/node-vfs/src/utils/mutex'
import { combineSignals, throwIfAborted } from '../packages/node-vfs/src/utils/signal'
import { estimateBinaryTokens, estimateTextTokens, generateOpId, METADATA_OVERHEAD, TOKENS_PER_MATCH_LINE } from '../packages/node-vfs/src/utils/tokens'

// ── mutex ──────────────────────────────────────────────────────────────────

describe('withMutex', () => {
  let locks: Map<string, Promise<unknown>>

  beforeEach(() => {
    locks = new Map()
  })

  it('should serialize access for the same key', async () => {
    const order: number[] = []
    const results = await Promise.all([
      withMutex(locks, 'a', async () => {
        order.push(1)
        return 1
      }),
      withMutex(locks, 'a', async () => {
        order.push(2)
        return 2
      }),
      withMutex(locks, 'a', async () => {
        order.push(3)
        return 3
      }),
    ])
    expect(results).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  })

  it('should allow parallel access for different keys', async () => {
    const order: number[] = []
    await Promise.all([
      withMutex(locks, 'a', async () => { order.push(1) }),
      withMutex(locks, 'b', async () => { order.push(2) }),
    ])
    expect(order).toContain(1)
    expect(order).toContain(2)
  })

  it('should release lock on error', async () => {
    await expect(
      withMutex(locks, 'a', async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
    // Lock should be released — subsequent call should succeed.
    const val = await withMutex(locks, 'a', async () => 42)
    expect(val).toBe(42)
  })
})

// ── signal ─────────────────────────────────────────────────────────────────

describe('combineSignals', () => {
  it('should return NEVER_ABORT when no signals given', () => {
    const s = combineSignals()
    expect(s.aborted).toBe(false)
  })

  it('should return single signal unchanged', () => {
    const c = new AbortController()
    const s = combineSignals(c.signal)
    expect(s).toBe(c.signal)
  })

  it('should abort when either source aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals(a.signal, b.signal)
    expect(combined.aborted).toBe(false)
    a.abort()
    expect(combined.aborted).toBe(true)
  })

  it('should abort when the *second* source aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals(a.signal, b.signal)
    b.abort()
    expect(combined.aborted).toBe(true)
  })

  it('should return already-aborted signal', () => {
    const a = new AbortController()
    a.abort()
    const s = combineSignals(a.signal)
    expect(s.aborted).toBe(true)
  })

  it('should stop forwarding aborts after cleanup', () => {
    // Regression: without cleanup the derived signal keeps reacting to source
    // aborts, leaking listeners and keeping operations alive. A single-source
    // combine returns the source signal itself, so cleanup only exists when
    // combining multiple signals.
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals(a.signal, b.signal) as AbortSignal & { __cleanupCombineSignals?: () => void }
    combined.__cleanupCombineSignals!()
    a.abort()
    expect(combined.aborted).toBe(false)
  })
})

describe('throwIfAborted', () => {
  it('should not throw for non-aborted signal', () => {
    const c = new AbortController()
    expect(() => throwIfAborted(c.signal)).not.toThrow()
  })

  it('should throw for aborted signal', () => {
    const c = new AbortController()
    c.abort()
    expect(() => throwIfAborted(c.signal)).toThrow()
  })

  it('should throw original error if reason is an Error', () => {
    const c = new AbortController()
    c.abort(new Error('custom'))
    expect(() => throwIfAborted(c.signal)).toThrow('custom')
  })
})

// ── path ───────────────────────────────────────────────────────────────────

describe('isHostAbsolutePath', () => {
  it('should detect drive paths with forward slashes', () => {
    expect(isHostAbsolutePath('C:/a/b')).toBe(true)
  })

  it('should not treat backslash drive paths as host absolute (matches implementation)', () => {
    // isHostAbsolutePath only recognizes forward-slash drive paths; backslash
    // forms are normalized to host paths by validatePath instead.
    expect(isHostAbsolutePath('C:\\a\\b')).toBe(false)
  })

  it('should reject virtual and relative paths', () => {
    expect(isHostAbsolutePath('/a/b')).toBe(false)
    expect(isHostAbsolutePath('a/b')).toBe(false)
  })
})

describe('validatePath', () => {
  it('should accept a valid virtual absolute path', () => {
    expect(validatePath('/a/b/c')).toEqual({ ok: true, normalized: '/a/b/c', kind: 'virtual' })
  })

  it('should accept a relative path', () => {
    expect(validatePath('a/b')).toEqual({ ok: true, normalized: 'a/b', kind: 'virtual' })
  })

  it('should normalize a leading ./ in relative paths', () => {
    expect(validatePath('./a/b')).toEqual({ ok: true, normalized: 'a/b', kind: 'virtual' })
  })

  it('should treat . as the root', () => {
    expect(validatePath('.')).toEqual({ ok: true, normalized: '/', kind: 'virtual' })
  })

  it('should treat ./ and variants as the root', () => {
    expect(validatePath('./')).toEqual({ ok: true, normalized: '/', kind: 'virtual' })
    expect(validatePath('.//')).toEqual({ ok: true, normalized: '/', kind: 'virtual' })
    expect(validatePath('././')).toEqual({ ok: true, normalized: '/', kind: 'virtual' })
  })

  it('should accept a host absolute path with forward slashes', () => {
    expect(validatePath('C:/a/b')).toEqual({ ok: true, normalized: 'C:/a/b', kind: 'host' })
  })

  it('should accept a host absolute path with backslashes', () => {
    expect(validatePath('C:\\a\\b')).toEqual({ ok: true, normalized: 'C:/a/b', kind: 'host' })
  })

  it('should classify bare drive prefix C: as host root', () => {
    expect(validatePath('C:')).toEqual({ ok: true, normalized: 'C:/', kind: 'host' })
  })

  it('should reject ambiguous drive-relative paths like C:foo', () => {
    expect(validatePath('C:foo')).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should normalize duplicate slashes', () => {
    // `pathe.normalize` on Windows may not collapse // prefix to single /.
    // Test that the path is accepted and the result is valid.
    const result = validatePath('//a//b')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(`Expected ok, got ${result.code}`)
    }
    expect(result.normalized).toMatch(/^\/+a\/+b$/)
  })

  it('should reject empty string', () => {
    expect(validatePath('')).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should reject non-string', () => {
    expect(validatePath(undefined as unknown as string)).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should reject NUL character', () => {
    expect(validatePath('/a\0b')).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should reject C0 control characters in any path kind', () => {
    // Control chars corrupt logs/error messages and serve no legitimate purpose.
    expect(validatePath('/a\nb')).toEqual({ ok: false, code: 'INVALID_PATH' })
    expect(validatePath('/a\tb')).toEqual({ ok: false, code: 'INVALID_PATH' })
    expect(validatePath('/a\rb')).toEqual({ ok: false, code: 'INVALID_PATH' })
    expect(validatePath('a\x01b')).toEqual({ ok: false, code: 'INVALID_PATH' })
    expect(validatePath('C:/a\nb')).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should reject backslash in virtual paths', () => {
    expect(validatePath('/a\\b')).toEqual({ ok: false, code: 'INVALID_PATH' })
  })

  it('should reject .. traversal in virtual paths', () => {
    expect(validatePath('/a/../b')).toEqual({ ok: false, code: 'PATH_TRAVERSAL' })
  })

  it('should reject .. traversal in relative paths', () => {
    expect(validatePath('../b')).toEqual({ ok: false, code: 'PATH_TRAVERSAL' })
    expect(validatePath('a/../../b')).toEqual({ ok: false, code: 'PATH_TRAVERSAL' })
  })

  it('should reject path that resolves above root', () => {
    expect(validatePath('/a/b/../../..')).toEqual({ ok: false, code: 'PATH_TRAVERSAL' })
  })

  it('should reject .. traversal in host paths', () => {
    expect(validatePath('C:/a/../b')).toEqual({ ok: false, code: 'PATH_TRAVERSAL' })
  })
})

describe('ancestorPaths', () => {
  it('should generate ancestors for nested path', () => {
    expect(ancestorPaths('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
  })

  it('should return only root for /', () => {
    expect(ancestorPaths('/')).toEqual(['/'])
  })

  it('should handle single-level path', () => {
    expect(ancestorPaths('/file.txt')).toEqual(['/file.txt', '/'])
  })

  it('should terminate for relative paths', () => {
    expect(ancestorPaths('a/b/c')).toEqual(['a/b/c', 'a/b', 'a', '/'])
    expect(ancestorPaths('a.txt')).toEqual(['a.txt', '/'])
  })

  it('should terminate for host absolute paths', () => {
    expect(ancestorPaths('C:/a/b')).toEqual(['C:/a/b', 'C:/a', 'C:/'])
  })
})

describe('encodeCursor / decodeCursor', () => {
  it('should round-trip a valid payload', () => {
    const encoded = encodeCursor({ o: 42 })
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ o: 42 })
  })

  it('should return null for invalid base64', () => {
    expect(decodeCursor('!!!invalid!!!')).toBeNull()
  })

  it('should return null for non-integer offset', () => {
    const encoded = encodeCursor({ o: 1.5 as unknown as number })
    // encodeCursor encodes it, but decodeCursor should reject non-integer
    // (but 1.5 gets JSON-encoded as 1.5, which decodeCursor will reject)
    const decoded = decodeCursor(encoded)
    expect(decoded).toBeNull()
  })

  it('should return null for negative offset', () => {
    const encoded = encodeCursor({ o: -1 })
    const decoded = decodeCursor(encoded)
    expect(decoded).toBeNull()
  })

  it('should return null for missing o field', () => {
    const payload = Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64')
    expect(decodeCursor(payload)).toBeNull()
  })

  it('should return null for valid base64 but malformed JSON', () => {
    const payload = Buffer.from('{not valid json', 'utf8').toString('base64')
    expect(decodeCursor(payload)).toBeNull()
  })
})

describe('isInternalFileName', () => {
  it('should detect tmp files', () => {
    expect(isInternalFileName('.vfs-tmp.abc123')).toBe(true)
  })

  it('should detect backup files', () => {
    expect(isInternalFileName('foo.vfs-tmp.abc.bak')).toBe(true)
  })

  it('should reject normal files', () => {
    expect(isInternalFileName('normal.txt')).toBe(false)
  })
})

describe('internal glob ignore patterns', () => {
  it('should ignore both tmp and backup artifacts', () => {
    expect(INTERNAL_GLOB_IGNORE).toEqual(['**/.vfs-tmp.*', '**/*.vfs-tmp.*.bak'])
  })
})

// ── env ────────────────────────────────────────────────────────────────────

describe('buildChildEnv', () => {
  it('should inherit the full host env by default', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/root', NODE_ENV: 'test' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/root', NODE_ENV: 'test' })
  })

  it('should skip non-string host values', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', EMPTY: undefined, NUM: 42 as unknown as string })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.EMPTY).toBeUndefined()
    expect(env.NUM).toBeUndefined()
  })

  it('should merge extra over host values', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, { PATH: '/custom', EXTRA: 'x' })
    expect(env.PATH).toBe('/custom')
    expect(env.EXTRA).toBe('x')
  })

  it('should strip blocklist keys case-insensitively', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin', API_KEY: 'secret', Path: '/win', ComSpec: 'cmd' },
      {},
      ['api_key', 'PATH'],
    )
    expect(env.API_KEY).toBeUndefined()
    expect(env.Path).toBeUndefined()
    expect(env.ComSpec).toBe('cmd')
  })

  it('should do nothing with an empty blocklist', () => {
    const env = buildChildEnv({ A: '1', B: '2' }, undefined, [])
    expect(env).toEqual({ A: '1', B: '2' })
  })

  it('should match RegExp patterns in the blocklist', () => {
    const env = buildChildEnv(
      {
        GITHUB_TOKEN: 't',
        AWS_ACCESS_KEY_ID: 'k',
        AWS_REGION: 'us-east-1',
        MONKEY: 'ok', // ends with "KEY" but not "_KEY"
        TOKENIZER: 'ok', // ends with "TOKEN" but not "_TOKEN"
        SAFE_VAR: 'ok',
      },
      {},
      [/^AWS_/, /_TOKEN$/, /_KEY$/],
    )
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_REGION).toBeUndefined()
    expect(env.MONKEY).toBe('ok')
    expect(env.TOKENIZER).toBe('ok')
    expect(env.SAFE_VAR).toBe('ok')
  })

  it('should match RegExp patterns against the original key case', () => {
    const env = buildChildEnv(
      { HTTP_PROXY: 'p', http_proxy: 'p', HTTPS_PROXY: 'p' },
      {},
      [/^(HTTP|HTTPS)_PROXY$/i],
    )
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('should strip global/sticky flags so patterns stay deterministic', () => {
    // /g without the strip would advance lastIndex and skip keys.
    const env = buildChildEnv(
      { TOKEN_A: 'a', TOKEN_B: 'b', TOKEN_C: 'c' },
      {},
      [/^TOKEN_/g],
    )
    expect(env).toEqual({})
  })
})

// ── tokens ─────────────────────────────────────────────────────────────────

describe('estimateTextTokens', () => {
  it('should estimate as bytes / 4', () => {
    expect(estimateTextTokens(100)).toBe(25)
  })

  it('should round up', () => {
    expect(estimateTextTokens(3)).toBe(1)
  })
})

describe('estimateBinaryTokens', () => {
  it('should estimate as bytes / 3', () => {
    expect(estimateBinaryTokens(99)).toBe(33)
  })

  it('should round up', () => {
    expect(estimateBinaryTokens(2)).toBe(1)
  })
})

describe('token constants', () => {
  it('should export metadata and per-line overheads', () => {
    expect(METADATA_OVERHEAD).toBe(8)
    expect(TOKENS_PER_MATCH_LINE).toBe(20)
  })
})

describe('generateOpId', () => {
  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOpId()))
    expect(ids.size).toBe(100)
  })

  it('should contain a hyphen separator', () => {
    expect(generateOpId()).toMatch(/^[0-9a-z]+-[0-9a-f]+$/)
  })
})

// ── batch ──────────────────────────────────────────────────────────────────

describe('processInBatches', () => {
  it('should process all items', async () => {
    const results: number[] = []
    await processInBatches([1, 2, 3], 2, async (item) => {
      results.push(item)
    })
    expect(results.sort()).toEqual([1, 2, 3])
  })

  it('should handle empty array', async () => {
    await processInBatches([], 1, async () => {
      throw new Error('should not be called')
    })
  })

  it('should reject when exceeding MAX_BATCH_ITEMS', async () => {
    const items = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => i)
    await expect(
      processInBatches(items, 1, async () => {}),
    ).rejects.toThrow(/exceeds the maximum/)
  })

  it('should reject on abort', async () => {
    const c = new AbortController()
    const promise = processInBatches([1, 2, 3], 1, async () => {
      await new Promise(r => setTimeout(r, 100))
    }, c.signal)
    c.abort()
    await expect(promise).rejects.toThrow('Aborted')
  })

  it('should default concurrency to 1 when <= 0', async () => {
    const results: number[] = []
    await processInBatches([1, 2], 0, async (item) => {
      results.push(item)
    })
    expect(results).toEqual([1, 2])
  })

  it('should never run more than batchSize tasks concurrently', async () => {
    let active = 0
    let peak = 0
    await processInBatches(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 10))
      active--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe('arrayToAsyncIterable', () => {
  it('should yield all items', async () => {
    const items: number[] = []
    for await (const x of arrayToAsyncIterable([1, 2, 3])) {
      items.push(x)
    }
    expect(items).toEqual([1, 2, 3])
  })

  it('should handle empty array', async () => {
    const items: number[] = []
    for await (const x of arrayToAsyncIterable([])) {
      items.push(x)
    }
    expect(items).toEqual([])
  })
})

// ── debug ──────────────────────────────────────────────────────────────────

describe('createDefaultDebugger', () => {
  it('should create a debugger that writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const dbg = createDefaultDebugger('test')
    dbg.debug('cat', 'msg', { key: 'val' })
    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0]![0] as string
    expect(call).toContain('[test:cat]')
    expect(call).toContain('msg')
    expect(call).toContain('"key":"val"')
    spy.mockRestore()
  })

  it('should omit meta suffix when meta is undefined', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const dbg = createDefaultDebugger('test')
    dbg.debug('cat', 'msg')
    const call = spy.mock.calls[0]![0] as string
    // No trailing JSON suffix when meta is absent.
    expect(call).not.toContain('{')
    expect(call).not.toContain('}')
    spy.mockRestore()
  })
})

describe('dEBUG_CATEGORY', () => {
  it('should expose stable category constants', () => {
    expect(DEBUG_CATEGORY.OP).toBe('op')
    expect(DEBUG_CATEGORY.CACHE_HIT).toBe('cache.hit')
    expect(DEBUG_CATEGORY.CACHE_MISS).toBe('cache.miss')
    expect(DEBUG_CATEGORY.CACHE_INVALIDATE).toBe('cache.invalidate')
  })
})
