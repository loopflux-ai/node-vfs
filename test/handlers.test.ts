/**
 * Handler tests: all operation handlers (file ops, query ops, execute).
 */
import type { ExecuteConfig, ExecutionContext, Op } from '../packages/node-vfs/src/types'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../packages/node-vfs/src/backend/memory'
import { dispatch } from '../packages/node-vfs/src/handlers/dispatch'
import { handleExecute } from '../packages/node-vfs/src/handlers/execute'
import { handleDeleteFile, handleEditFile, handleReadFile, handleWriteFile } from '../packages/node-vfs/src/handlers/files'
import { OP_KIND } from '../packages/node-vfs/src/handlers/kinds'
import { handleGlob, handleGrep, handleLs } from '../packages/node-vfs/src/handlers/query'
import { MAX_BATCH_ITEMS } from '../packages/node-vfs/src/utils/batch'
import { collect, expectErrResult, expectOkResult, makeCtx, readAll } from './helpers'

const WRITE_MODE = 'overwrite'

describe('handleReadFile', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should read file content', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('hello'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
    }, ctx)
    expectOkResult(result)
    expect(await readAll(expectOkResult(result).data)).toBe('hello')
  })

  it('should return NOT_FOUND for missing file', async () => {
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/nope',
    }, ctx)
    expect(expectErrResult(result).code).toBe('NOT_FOUND')
  })

  it('should return IS_DIRECTORY for directories', async () => {
    await backend.write('/dir/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/dir',
    }, ctx)
    expect(expectErrResult(result).code).toBe('IS_DIRECTORY')
  })

  it('should support range read', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abcdef'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
      range: { start: 1, end: 4 },
    }, ctx)
    expect(await readAll(expectOkResult(result).data)).toBe('bcd')
  })

  it('should clamp an end offset beyond the file size', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abc'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
      range: { start: 0, end: 100 },
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.range).toEqual({ start: 0, end: 3 })
    expect(await readAll(ok.data)).toBe('abc')
  })

  it('should read an empty file with zero bytes returned', async () => {
    await backend.write('/empty.txt', new TextEncoder().encode(''), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/empty.txt',
      range: { start: 0, end: 0 },
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.bytesReturned).toBe(0)
    expect(await readAll(ok.data)).toBe('')
  })

  it('should reject negative range start', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abc'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
      range: { start: -1, end: 3 },
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATH')
  })

  it('should reject start > end', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abc'), WRITE_MODE)
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
      range: { start: 3, end: 1 },
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATH')
  })

  it('should return FILE_TOO_LARGE when range exceeds limit', async () => {
    const data = new Uint8Array(1000)
    await backend.write('/big.txt', data, WRITE_MODE)
    const smallCtx = makeCtx({ limits: { maxFileSize: 100 } })
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/big.txt',
      range: { start: 0, end: 200 },
    }, smallCtx)
    expect(expectErrResult(result).code).toBe('FILE_TOO_LARGE')
  })

  it('should return ABORTED when signal is aborted', async () => {
    const c = new AbortController()
    c.abort()
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
    }, makeCtx({ signal: c.signal }))
    expect(expectErrResult(result).code).toBe('ABORTED')
  })

  it('should mark the stream truncated when the consumer aborts mid-read', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('hello'), WRITE_MODE)
    const c = new AbortController()
    const result = await handleReadFile(backend, {
      kind: OP_KIND.READ_FILE,
      id: '1',
      path: '/f.txt',
    }, makeCtx({ signal: c.signal }))
    const ok = expectOkResult(result)

    const iterator = ok.data[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    c.abort()
    const second = await iterator.next()
    expect(second.done).toBe(true)
    expect(ok.meta.truncated).toBe(true)
  })

  it('should map a stream EACCES error to PERMISSION_DENIED', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('hello'), WRITE_MODE)
    const originalRead = backend.read.bind(backend)
    backend.read = (async function* () {
      const e = new Error('permission denied') as NodeJS.ErrnoException
      e.code = 'EACCES'
      throw e
    }) as typeof backend.read
    try {
      const result = await handleReadFile(backend, {
        kind: OP_KIND.READ_FILE,
        id: '1',
        path: '/f.txt',
      }, ctx)
      const ok = expectOkResult(result)
      await expect(readAll(ok.data)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }
    finally {
      backend.read = originalRead
    }
  })
})

describe('handleWriteFile', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should write a file', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/f.txt',
      content: 'hello',
      mode: 'overwrite',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.data.bytesWritten).toBe(5)
    expect(ok.data.path).toBe('/f.txt')
    expect(ok.data.encoding).toBe('utf8')
  })

  it('should return ALREADY_EXISTS for create mode on existing file', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'), 'create')
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/f.txt',
      content: 'y',
      mode: 'create',
    }, ctx)
    expect(expectErrResult(result).code).toBe('ALREADY_EXISTS')
  })

  it('should reject writing to root', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/',
      content: 'x',
      mode: 'overwrite',
    }, ctx)
    expect(expectErrResult(result).code).toBe('NOT_DIRECTORY')
  })

  it('should reject writing to a directory', async () => {
    await backend.write('/dir/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/dir',
      content: 'x',
      mode: 'overwrite',
    }, ctx)
    expect(expectErrResult(result).code).toBe('IS_DIRECTORY')
  })

  it('should check append combined size', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const smallCtx = makeCtx({ limits: { maxFileSize: 2 } })
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/f.txt',
      content: 'yy',
      mode: 'append',
    }, smallCtx)
    expect(expectErrResult(result).code).toBe('FILE_TOO_LARGE')
  })

  it('should decode hex-encoded content', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/hex.txt',
      content: '68656c6c6f',
      mode: 'overwrite',
      encoding: 'hex',
    }, ctx)
    expectOkResult(result)
    const stored = await readAll(backend.read('/hex.txt'))
    expect(stored).toBe('hello')
  })

  it('should reject malformed hex content', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/bad.txt',
      content: 'zz',
      mode: 'overwrite',
      encoding: 'hex',
    }, ctx)
    const errResult = expectErrResult(result)
    expect(errResult.code).toBe('UNSUPPORTED')
  })

  it('should decode base64-encoded content', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/b64.txt',
      content: 'aGVsbG8gd29ybGQ=',
      mode: 'overwrite',
      encoding: 'base64',
    }, ctx)
    expectOkResult(result)
    expect(await readAll(backend.read('/b64.txt'))).toBe('hello world')
  })

  it('should reject malformed base64 content', async () => {
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/bad64.txt',
      content: '***not base64***',
      mode: 'overwrite',
      encoding: 'base64',
    }, ctx)
    expect(expectErrResult(result).code).toBe('UNSUPPORTED')
  })

  it('should accept raw Uint8Array content', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xFF])
    const result = await handleWriteFile(backend, {
      kind: OP_KIND.WRITE_FILE,
      id: '1',
      path: '/bin.dat',
      content: bytes,
      mode: 'overwrite',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.data.encoding).toBeUndefined() // encoding only reported for string content
    const stored = await collect(backend.read('/bin.dat'))
    expect(Buffer.concat(stored)).toEqual(Buffer.from(bytes))
  })
})

describe('handleEditFile', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should edit a file', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('hello world'), WRITE_MODE)
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'world',
      newText: 'there',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.data.occurrences).toBe(1)
    expect(await readAll(backend.read('/f.txt'))).toBe('hello there')
  })

  it('should return OLD_TEXT_NOT_FOUND', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abc'), WRITE_MODE)
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'xyz',
      newText: 'new',
    }, ctx)
    expect(expectErrResult(result).code).toBe('OLD_TEXT_NOT_FOUND')
  })

  it('should return OLD_TEXT_EMPTY for empty oldText', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('abc'), WRITE_MODE)
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: '  ',
      newText: 'new',
    }, ctx)
    expect(expectErrResult(result).code).toBe('OLD_TEXT_EMPTY')
  })

  it('should return AMBIGUOUS for multiple matches', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('ab ab'), WRITE_MODE)
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'ab',
      newText: 'cd',
    }, ctx)
    expect(expectErrResult(result).code).toBe('AMBIGUOUS')
  })

  it('should return FILE_TOO_LARGE when source exceeds maxEditSize', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'.repeat(500)), WRITE_MODE)
    const smallCtx = makeCtx({ limits: { maxEditSize: 10 } })
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'x',
      newText: 'y',
    }, smallCtx)
    expect(expectErrResult(result).code).toBe('FILE_TOO_LARGE')
  })

  it('should return FILE_TOO_LARGE when the edited result exceeds maxEditSize', async () => {
    // The source fits, but replacing oldText with a much larger newText does not.
    await backend.write('/f.txt', new TextEncoder().encode('ab'), WRITE_MODE)
    const smallCtx = makeCtx({ limits: { maxEditSize: 10 } })
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'b',
      newText: 'x'.repeat(20),
    }, smallCtx)
    expect(expectErrResult(result).code).toBe('FILE_TOO_LARGE')
  })

  it('should not modify the file when the edit is rejected', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('original'), WRITE_MODE)
    const result = await handleEditFile(backend, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'missing',
      newText: 'changed',
    }, ctx)
    expectErrResult(result)
    expect(await readAll(backend.read('/f.txt'))).toBe('original')
  })

  it('should return CONFLICT when the file changed between read and write', async () => {
    let statCalls = 0
    const fakeBackend = {
      stat: async () => {
        statCalls++
        return statCalls === 1
          ? { size: 5, isDirectory: false, mtimeMs: 100 }
          : { size: 6, isDirectory: false, mtimeMs: 200 }
      },
      read: () => ({
        async* [Symbol.asyncIterator]() {
          yield new TextEncoder().encode('hello')
        },
      }),
      write: async () => ({ bytesWritten: 6, deltaBytes: 1, mode: 'overwrite' }),
    }
    const result = await handleEditFile(fakeBackend as never, {
      kind: OP_KIND.EDIT_FILE,
      id: '1',
      path: '/f.txt',
      oldText: 'hello',
      newText: 'world',
    }, ctx)
    expect(expectErrResult(result).code).toBe('CONFLICT')
    expect(statCalls).toBe(2)
  })
})

describe('handleDeleteFile', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should delete a file', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleDeleteFile(backend, {
      kind: OP_KIND.DELETE_FILE,
      id: '1',
      path: '/f.txt',
    }, ctx)
    expectOkResult(result)
    expect(await backend.stat('/f.txt')).toBeNull()
  })

  it('should return NOT_FOUND for missing file', async () => {
    const result = await handleDeleteFile(backend, {
      kind: OP_KIND.DELETE_FILE,
      id: '1',
      path: '/no',
    }, ctx)
    expect(expectErrResult(result).code).toBe('NOT_FOUND')
  })

  it('should require recursive flag for directories', async () => {
    await backend.write('/dir/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleDeleteFile(backend, {
      kind: OP_KIND.DELETE_FILE,
      id: '1',
      path: '/dir',
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATH')
  })

  it('should delete directory with recursive flag', async () => {
    await backend.write('/dir/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleDeleteFile(backend, {
      kind: OP_KIND.DELETE_FILE,
      id: '1',
      path: '/dir',
      recursive: true,
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.bytesFreed).toBe(1)
    expect(await backend.stat('/dir')).toBeNull()
  })
})

// ── Query handlers ─────────────────────────────────────────────────────────

describe('handleGrep', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should find matching lines', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('hello\nworld\nhello again'), WRITE_MODE)
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: 'hello',
    }, ctx)
    const ok = expectOkResult(result)
    const matches = await collect(ok.data)
    expect(matches.map(m => m.text)).toEqual(['hello', 'hello again'])
  })

  it('should respect maxResults', async () => {
    // Without flags, grep uses literal substring matching — 'a' hits every line.
    await backend.write('/f.txt', new TextEncoder().encode('aa\nab\nac\nad\nae'), WRITE_MODE)
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: 'a',
      maxResults: 2,
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.matchCount).toBe(2)
    expect(ok.meta.truncated).toBe(true)
    expect(ok.meta.truncateReason).toBe('maxResults')
  })

  it('should reject empty pattern', async () => {
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: '',
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATTERN')
  })

  it('should reject overlong patterns', async () => {
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: 'x'.repeat(5000),
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATTERN')
  })

  it('should support case-insensitive flag', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('HELLO world'), WRITE_MODE)
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: 'hello',
      flags: 'i',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.matchCount).toBe(1)
  })

  it('should reject unsupported flags', async () => {
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/',
      pattern: 'x',
      flags: 'z',
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATTERN')
  })

  it('should return empty matches for a non-existent root path', async () => {
    const result = await handleGrep(backend, {
      kind: OP_KIND.GREP,
      id: '1',
      path: '/noexist',
      pattern: 'x',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.meta.filesSearched).toBe(0)
    expect(await collect(ok.data)).toEqual([])
  })
})

describe('handleLs', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should list directory entries', async () => {
    await backend.write('/a.txt', new TextEncoder().encode('x'), WRITE_MODE)
    await backend.write('/b.txt', new TextEncoder().encode('y'), WRITE_MODE)
    const result = await handleLs(backend, {
      kind: OP_KIND.LS,
      id: '1',
      path: '/',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.data.entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('should return NOT_DIRECTORY for files', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleLs(backend, {
      kind: OP_KIND.LS,
      id: '1',
      path: '/f.txt',
    }, ctx)
    expect(expectErrResult(result).code).toBe('NOT_DIRECTORY')
  })

  it('should paginate with a stable cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await backend.write(`/f${i}.txt`, new TextEncoder().encode('x'), WRITE_MODE)
    }
    const page1 = await handleLs(backend, {
      kind: OP_KIND.LS,
      id: '1',
      path: '/',
      limit: 2,
    }, ctx)
    const ok1 = expectOkResult(page1)
    expect(ok1.data.entries).toHaveLength(2)
    expect(ok1.data.nextCursor).toBeDefined()

    const page2 = await handleLs(backend, {
      kind: OP_KIND.LS,
      id: '2',
      path: '/',
      limit: 2,
      cursor: ok1.data.nextCursor,
    }, ctx)
    const ok2 = expectOkResult(page2)
    expect(ok2.data.entries).toHaveLength(2)
    // Pages must not overlap.
    const seen = new Set([...ok1.data.entries, ...ok2.data.entries].map(e => e.name))
    expect(seen.size).toBe(4)
  })

  it('should return INVALID_CURSOR for a malformed cursor', async () => {
    await backend.write('/f.txt', new TextEncoder().encode('x'), WRITE_MODE)
    const result = await handleLs(backend, {
      kind: OP_KIND.LS,
      id: '1',
      path: '/',
      cursor: '!!!invalid!!!',
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_CURSOR')
  })

  it('should return TOO_MANY_FILES when the directory exceeds the batch cap', async () => {
    const many = new InMemoryBackend()
    many.listDir = async () => Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => `f${i}.txt`)
    const result = await handleLs(many, {
      kind: OP_KIND.LS,
      id: '1',
      path: '/',
    }, ctx)
    expect(expectErrResult(result).code).toBe('TOO_MANY_FILES')
  })
})

describe('handleGlob', () => {
  let backend: InMemoryBackend
  let ctx: ExecutionContext

  beforeEach(() => {
    backend = new InMemoryBackend()
    ctx = makeCtx()
  })

  it('should match files by pattern', async () => {
    await backend.write('/a.ts', new TextEncoder().encode('x'), WRITE_MODE)
    await backend.write('/b.ts', new TextEncoder().encode('y'), WRITE_MODE)
    await backend.write('/c.js', new TextEncoder().encode('z'), WRITE_MODE)
    const result = await handleGlob(backend, {
      kind: OP_KIND.GLOB,
      id: '1',
      path: '/',
      pattern: '**/*.ts',
    }, ctx)
    const ok = expectOkResult(result)
    expect(ok.data.entries.map(e => e.name).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('should return empty for no matches', async () => {
    const result = await handleGlob(backend, {
      kind: OP_KIND.GLOB,
      id: '1',
      path: '/',
      pattern: '*.nonexistent',
    }, ctx)
    expect(expectOkResult(result).data.entries).toEqual([])
  })

  it('should reject overlong patterns', async () => {
    const result = await handleGlob(backend, {
      kind: OP_KIND.GLOB,
      id: '1',
      path: '/',
      pattern: '*'.repeat(5000),
    }, ctx)
    expect(expectErrResult(result).code).toBe('INVALID_PATTERN')
  })

  it('should reject traversal patterns with ".." segments', async () => {
    // Regression: fastGlob would match files outside the sandbox root; the
    // handler must reject the pattern with an LLM-actionable error instead.
    for (const pattern of ['../secret.txt', 'a/../../secret.txt', '..\\secret.txt']) {
      const result = await handleGlob(backend, {
        kind: OP_KIND.GLOB,
        id: '1',
        path: '/',
        pattern,
      }, ctx)
      expect(expectErrResult(result).code).toBe('INVALID_PATTERN')
    }
  })

  it('should return TOO_MANY_FILES when matches exceed the batch cap', async () => {
    const many = new InMemoryBackend()
    many.globFiles = async () => Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => `f${i}.ts`)
    const result = await handleGlob(many, {
      kind: OP_KIND.GLOB,
      id: '1',
      path: '/',
      pattern: '*.ts',
    }, ctx)
    expect(expectErrResult(result).code).toBe('TOO_MANY_FILES')
  })
})

// ── Execute handler ────────────────────────────────────────────────────────

describe('handleExecute', () => {
  it('should return UNSUPPORTED for InMemoryBackend', async () => {
    const backend = new InMemoryBackend()
    const result = await handleExecute(backend, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'echo',
      args: ['hi'],
    }, makeCtx())
    expect(expectErrResult(result).code).toBe('UNSUPPORTED')
  })

  it('should clamp per-op overrides to the instance limits', async () => {
    let received: ExecuteConfig | undefined
    const fakeBackend = {
      execute: async (config: ExecuteConfig) => {
        received = config
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, wasKilled: false, truncated: false, durationMs: 1 }
      },
    }
    const ctx = makeCtx({ limits: { maxExecuteMs: 1000, maxOutputBytes: 1024 }, executeConfig: { allowCommands: ['x'] } })
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'x',
      timeoutMs: 99_999,
      maxOutputBytes: 99_999,
    }, ctx)
    expectOkResult(result)
    expect(received!.timeoutMs).toBe(1000)
    expect(received!.maxOutputBytes).toBe(1024)
  })

  it('should map EXEC_FAILED from backend errors', async () => {
    // Simulate a backend that throws on execute.
    const fakeBackend = {
      execute: async () => {
        const err = new Error('command failed') as Error & { code?: string, meta?: Record<string, unknown> }
        err.code = 'EXEC_FAILED'
        err.meta = {
          command: 'bad',
          exitCode: 1,
          timedOut: false,
          isCanceled: false,
          killed: false,
          partialStderr: 'error output',
        }
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'bad',
    }, makeCtx({ executeConfig: { allowCommands: ['bad'] } }))
    expect(expectErrResult(result).code).toBe('EXEC_FAILED')
  })

  it('should map ABORTED from backend errors', async () => {
    const fakeBackend = {
      execute: async () => {
        const err = new Error('cancelled') as Error & { code?: string }
        err.code = 'ABORTED'
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'cmd',
    }, makeCtx({ executeConfig: { allowCommands: ['cmd'] } }))
    expect(expectErrResult(result).code).toBe('ABORTED')
  })

  it('should map COMMAND_NOT_FOUND from backend errors', async () => {
    const fakeBackend = {
      execute: async () => {
        const err = new Error('not found') as Error & { code?: string }
        err.code = 'COMMAND_NOT_FOUND'
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'no-such-cmd',
    }, makeCtx({ executeConfig: { allowCommands: ['no-such-cmd'] } }))
    expect(expectErrResult(result).code).toBe('COMMAND_NOT_FOUND')
  })

  it('should map OUTPUT_TOO_LARGE from backend errors', async () => {
    const fakeBackend = {
      execute: async () => {
        const err = new Error('output too large') as Error & { code?: string, meta?: Record<string, unknown> }
        err.code = 'OUTPUT_TOO_LARGE'
        err.meta = { stdoutBytes: 100, maxOutputBytes: 50 }
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'big',
    }, makeCtx({ executeConfig: { allowCommands: ['big'] } }))
    expect(expectErrResult(result).code).toBe('OUTPUT_TOO_LARGE')
  })

  it('should map ABORTED when signal is cancelled during execute', async () => {
    const c = new AbortController()
    c.abort()
    const fakeBackend = {
      execute: async () => {
        const err = new Error('cancelled') as Error & { code?: string, meta?: Record<string, unknown> }
        err.code = 'EXEC_FAILED'
        err.meta = { isCanceled: true, timedOut: false, killed: false, partialStderr: '' }
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'cmd',
    }, makeCtx({ signal: c.signal }))
    expect(expectErrResult(result).code).toBe('ABORTED')
  })

  it('should map INTERNAL_ERROR from backend errors', async () => {
    const fakeBackend = {
      execute: async () => {
        const err = new Error('internal crash') as Error & { code?: string, detail?: string }
        err.code = 'INTERNAL_ERROR'
        err.detail = 'disk failure'
        throw err
      },
    }
    const result = await handleExecute(fakeBackend as never, {
      kind: OP_KIND.EXECUTE,
      id: '1',
      command: 'crash',
    }, makeCtx({ executeConfig: { allowCommands: ['crash'] } }))
    expect(expectErrResult(result).code).toBe('INTERNAL_ERROR')
  })
})

// ── dispatch ───────────────────────────────────────────────────────────────

describe('dispatch', () => {
  it('should return UNSUPPORTED for an unknown op.kind', async () => {
    // The fallback branch in dispatch.ts must surface a structured ErrResult
    // (not throw) so the vfs facade can route it through the normal error path.
    const backend = new InMemoryBackend()
    const op = { kind: 'unknown_op', id: '1' } as unknown as Op
    const result = await dispatch(backend, op, makeCtx())
    const err = expectErrResult(result)
    expect(err.code).toBe('UNSUPPORTED')
    expect(err.error).toContain('No handler for op.kind=unknown_op')
    expect(err.opId).toBe('1')
  })
})
