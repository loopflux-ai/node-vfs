/**
 * VFS facade tests: path validation, dispatch, signals, error mapping.
 */
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesystemBackend } from '../packages/node-vfs/src/backend/filesystem'
import { InMemoryBackend } from '../packages/node-vfs/src/backend/memory'
import { OP_KIND } from '../packages/node-vfs/src/handlers/kinds'
import { createVFS } from '../packages/node-vfs/src/vfs'
import { expectErrResult, expectOkResult, readAll } from './helpers'
import { cleanupTempDir, createTempDir } from './setup'

describe('createVFS (InMemoryBackend)', () => {
  let vfs: ReturnType<typeof createVFS>

  beforeEach(() => {
    vfs = createVFS({ backend: new InMemoryBackend() })
  })

  describe('read_file', () => {
    it('should read file content', async () => {
      await vfs.write_file('/f.txt', 'hello')
      expect(await readAll(expectOkResult(await vfs.read_file('/f.txt')).data)).toBe('hello')
    })

    it('should read an empty file', async () => {
      await vfs.write_file('/empty.txt', '')
      const ok = expectOkResult(await vfs.read_file('/empty.txt'))
      expect(ok.meta.bytesReturned).toBe(0)
      expect(await readAll(ok.data)).toBe('')
    })

    it('should return error for non-existent file', async () => {
      expect(expectErrResult(await vfs.read_file('/noexist')).code).toBe('NOT_FOUND')
    })
  })

  describe('write_file', () => {
    it('should write and return result', async () => {
      const ok = expectOkResult(await vfs.write_file('/f.txt', 'hello'))
      expect(ok.data.bytesWritten).toBe(5)
    })

    it('should support overwrite mode', async () => {
      await vfs.write_file('/f.txt', 'hello')
      await vfs.write_file('/f.txt', 'world')
      expect(await readAll(expectOkResult(await vfs.read_file('/f.txt')).data)).toBe('world')
    })

    it('should support append mode', async () => {
      await vfs.write_file('/f.txt', 'ab')
      await vfs.write_file('/f.txt', 'cd', { mode: 'append' })
      expect(await readAll(expectOkResult(await vfs.read_file('/f.txt')).data)).toBe('abcd')
    })

    it('should support create mode', async () => {
      expectOkResult(await vfs.write_file('/new.txt', 'fresh', { mode: 'create' }))
    })

    it('should reject create when file exists', async () => {
      await vfs.write_file('/f.txt', 'x')
      expect(expectErrResult(await vfs.write_file('/f.txt', 'y', { mode: 'create' })).code).toBe('ALREADY_EXISTS')
    })

    it('should create intermediate directories implicitly', async () => {
      expectOkResult(await vfs.write_file('/deep/nested/file.txt', 'x'))
      const ls = expectOkResult(await vfs.ls('/deep/nested'))
      expect(ls.data.entries.map(e => e.name)).toEqual(['file.txt'])
    })
  })

  describe('edit_file', () => {
    it('should edit file content', async () => {
      await vfs.write_file('/f.txt', 'hello world')
      const ok = expectOkResult(await vfs.edit_file('/f.txt', 'world', 'there'))
      expect(ok.data.occurrences).toBe(1)
    })

    it('should return error for non-existent file', async () => {
      expect(expectErrResult(await vfs.edit_file('/no', 'old', 'new')).code).toBe('NOT_FOUND')
    })
  })

  describe('delete_file', () => {
    it('should delete a file', async () => {
      await vfs.write_file('/f.txt', 'x')
      expectOkResult(await vfs.delete_file('/f.txt'))
      expect(expectErrResult(await vfs.read_file('/f.txt')).code).toBe('NOT_FOUND')
    })
  })

  describe('grep', () => {
    it('should find matching patterns', async () => {
      await vfs.write_file('/f.txt', 'hello\nworld\nhello again')
      const ok = expectOkResult(await vfs.grep('/', 'hello'))
      const matches: string[] = []
      for await (const m of ok.data) matches.push(m.text)
      expect(matches).toHaveLength(2)
    })
  })

  describe('ls', () => {
    it('should list directory entries', async () => {
      await vfs.write_file('/a.txt', 'x')
      await vfs.write_file('/b.txt', 'y')
      expect(expectOkResult(await vfs.ls('/')).data.entries).toHaveLength(2)
    })
  })

  describe('glob', () => {
    it('should match files by pattern', async () => {
      await vfs.write_file('/a.ts', 'x')
      await vfs.write_file('/b.ts', 'y')
      await vfs.write_file('/c.js', 'z')
      expect(expectOkResult(await vfs.glob('/', '**/*.ts')).data.entries).toHaveLength(2)
    })
  })

  describe('mkdir', () => {
    it('should create a directory and make it visible to ls', async () => {
      const r = await vfs.mkdir('/sub')
      expect(expectOkResult(r).data.wasCreated).toBe(true)

      const ls = expectOkResult(await vfs.ls('/'))
      expect(ls.data.entries.some(e => e.name === 'sub')).toBe(true)
    })

    it('should be idempotent', async () => {
      await vfs.mkdir('/dir')
      expect(expectOkResult(await vfs.mkdir('/dir')).data.wasCreated).toBe(false)
    })

    it('should treat root as already existing', async () => {
      expect(expectOkResult(await vfs.mkdir('/')).data.wasCreated).toBe(false)
    })

    it('should reject when a file exists at the path', async () => {
      await vfs.write_file('/f.txt', 'x')
      expect(expectErrResult(await vfs.mkdir('/f.txt')).code).toBe('NOT_DIRECTORY')
    })
  })

  describe('execute', () => {
    it('should return UNSUPPORTED for InMemoryBackend', async () => {
      expect(expectErrResult(await vfs.execute('echo', { args: ['hi'] })).code).toBe('UNSUPPORTED')
    })

    it('should reject non-execute ops passed via the op-object overload', async () => {
      const r = await vfs.execute({ kind: OP_KIND.READ_FILE, id: 'x', path: '/f.txt' } as never)
      expect(expectErrResult(r).code).toBe('UNSUPPORTED')
    })
  })

  describe('cache config', () => {
    it('should honour the cache config field (built-in cache, default-on)', async () => {
      // Cache is no longer a user middleware — it is a built-in subsystem
      // appended innermost by createVFS and configured via the `cache` field.
      const v = createVFS({
        backend: new InMemoryBackend(),
        cache: { maxEntries: 5 },
      })
      await v.write_file('/f.txt', 'hello')
      expect(await readAll(expectOkResult(await v.read_file('/f.txt')).data)).toBe('hello')
    })

    it('should disable caching when cache is false', async () => {
      // With cache: false, the VFS passes the backend result through without
      // draining or storing. Removing the backend file after the first read
      // makes the second read miss (NOT_FOUND) — proving no cached copy was
      // retained.
      const backend = new InMemoryBackend()
      const v = createVFS({ backend, cache: false })
      await v.write_file('/f.txt', 'hello')
      expect(await readAll(expectOkResult(await v.read_file('/f.txt')).data)).toBe('hello')

      await backend.remove('/f.txt')
      expect(expectErrResult(await v.read_file('/f.txt')).code).toBe('NOT_FOUND')
    })

    it('should cache query results when cache is true', async () => {
      // With cache: true (explicit default-on), the first read drains and
      // stores a replayable copy. Deleting the backend file afterwards still
      // returns the cached content on the second read — proving the cache
      // retained it.
      const backend = new InMemoryBackend()
      const v = createVFS({ backend, cache: true })
      await v.write_file('/f.txt', 'hello')
      expect(await readAll(expectOkResult(await v.read_file('/f.txt')).data)).toBe('hello')

      await backend.remove('/f.txt')
      expect(await readAll(expectOkResult(await v.read_file('/f.txt')).data)).toBe('hello')
    })
  })

  describe('path validation', () => {
    it('should reject paths with ..', async () => {
      const r = expectErrResult(await vfs.read_file('/../etc/passwd'))
      expect(r.code).toBe('PATH_TRAVERSAL')
      expect(r.error).toContain('Path traversal rejected')
    })

    // One INVALID_PATH smoke test at the facade is enough — the full branch
    // matrix (NUL, control chars, backslash, drive-relative, etc.) lives in
    // utils.test.ts validatePath. NUL is the canonical representative.
    it('should reject invalid paths with INVALID_PATH', async () => {
      expect(expectErrResult(await vfs.read_file('/a\0b')).code).toBe('INVALID_PATH')
    })
  })

  describe('signal', () => {
    it('should abort operation when instance signal fires', async () => {
      const c = new AbortController()
      c.abort()
      const v = createVFS({ backend: new InMemoryBackend(), signal: c.signal })
      expect(expectErrResult(await v.read_file('/f.txt')).code).toBe('ABORTED')
    })

    it('should abort operation when per-op signal fires', async () => {
      const c = new AbortController()
      c.abort()
      expect(expectErrResult(await vfs.read_file('/f.txt', { signal: c.signal })).code).toBe('ABORTED')
    })
  })

  describe('result contracts', () => {
    it('should attach opId and kind to error results', async () => {
      const e = expectErrResult(await vfs.read_file('/missing'))
      expect(e.opId).toBeTypeOf('string')
      expect(e.opId.length).toBeGreaterThan(0)
      expect(e.kind).toBe('read_file')
    })

    it('should freeze error results', async () => {
      const e = expectErrResult(await vfs.read_file('/missing'))
      expect(Object.isFrozen(e)).toBe(true)
    })

    it('should expose the effective limits', () => {
      expect(vfs.limits).toMatchObject({
        maxFileSize: 10 * 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxExecuteMs: 60_000,
      })
    })

    it('should cap maxEditSize at maxFileSize', () => {
      const v = createVFS({
        backend: new InMemoryBackend(),
        limits: { maxEditSize: 5 * 1024 * 1024, maxFileSize: 1024 * 1024 },
      })
      expect(v.limits.maxEditSize).toBe(1024 * 1024)
    })
  })

  describe('debug', () => {
    it('should emit debug output when debug is enabled', async () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        const v = createVFS({ backend: new InMemoryBackend(), debug: true })
        await v.read_file('/nope')
        expect(spy).toHaveBeenCalled()
      }
      finally {
        spy.mockRestore()
      }
    })
  })

  describe('error mapping', () => {
    it('should map backend ENOENT errors to NOT_FOUND', async () => {
      const backend = new InMemoryBackend()
      const originalStat = backend.stat.bind(backend)
      backend.stat = async (path: string) => {
        if (path === '/boom') {
          const e = new Error('no such file') as NodeJS.ErrnoException
          e.code = 'ENOENT'
          throw e
        }
        return originalStat(path)
      }
      const v = createVFS({ backend })
      expect(expectErrResult(await v.read_file('/boom')).code).toBe('NOT_FOUND')
    })

    it('should map backend EACCES errors to PERMISSION_DENIED', async () => {
      const backend = new InMemoryBackend()
      const originalStat = backend.stat.bind(backend)
      backend.stat = async (path: string) => {
        if (path === '/denied') {
          const e = new Error('permission denied') as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        return originalStat(path)
      }
      const v = createVFS({ backend })
      expect(expectErrResult(await v.read_file('/denied')).code).toBe('PERMISSION_DENIED')
    })

    it('should fall back to INTERNAL_ERROR for unmapped backend errors', async () => {
      const backend = new InMemoryBackend()
      const originalStat = backend.stat.bind(backend)
      backend.stat = async (path: string) => {
        if (path === '/weird') {
          const e = new Error('something odd') as NodeJS.ErrnoException
          e.code = 'EUNKNOWNCODE'
          throw e
        }
        return originalStat(path)
      }
      const v = createVFS({ backend })
      expect(expectErrResult(await v.read_file('/weird')).code).toBe('INTERNAL_ERROR')
    })

    it('should map a read stream EACCES to PERMISSION_DENIED via cache drain', async () => {
      const root = await createTempDir()
      const backend = new FilesystemBackend({ rootDir: root })
      await backend.write('/f.txt', new TextEncoder().encode('hello'), 'overwrite')
      const spy = vi.spyOn(fsp, 'open').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
      try {
        const v = createVFS({ backend })
        // The default cache middleware drains the stream — the EACCES surfaces
        // as a PERMISSION_DENIED ErrResult instead of a raw stream error.
        expect(expectErrResult(await v.read_file('/f.txt')).code).toBe('PERMISSION_DENIED')
      }
      finally {
        spy.mockRestore()
        await cleanupTempDir(root)
      }
    })

    it('should map write_file mkdir EACCES to PERMISSION_DENIED', async () => {
      const root = await createTempDir()
      const backend = new FilesystemBackend({ rootDir: root })
      const spy = vi.spyOn(fsp, 'mkdir').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
      try {
        const v = createVFS({ backend })
        // backend.write does not wrap its own fsp.mkdir — the raw EACCES is
        // surfaced by the VFS facade's BACKEND_CODE_MAP.
        expect(expectErrResult(await v.write_file('/x/y.txt', 'data')).code).toBe('PERMISSION_DENIED')
      }
      finally {
        spy.mockRestore()
        await cleanupTempDir(root)
      }
    })

    it('should map execute cwd realpath EACCES to PERMISSION_DENIED', async () => {
      const root = await createTempDir()
      const backend = new FilesystemBackend({ rootDir: root })
      // resolveCwdInner's realpath sits outside resolve()'s ENOENT handling —
      // a raw EACCES must survive to the facade mapping.
      const spy = vi.spyOn(fsp, 'realpath').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
      try {
        const v = createVFS({ backend, execute: ['node'] })
        expect(expectErrResult(await v.execute('node', { args: ['x.js'], cwd: '/' })).code).toBe('PERMISSION_DENIED')
      }
      finally {
        spy.mockRestore()
        await cleanupTempDir(root)
      }
    })
  })

  describe('dispose', () => {
    it('should call backend dispose', async () => {
      let disposed = false
      const backend = new InMemoryBackend()
      backend.dispose = async () => {
        disposed = true
      }
      const v = createVFS({ backend })
      await v.dispose()
      expect(disposed).toBe(true)
    })
  })
})

// ── FilesystemBackend VFS ──────────────────────────────────────────────────

describe('createVFS (FilesystemBackend)', () => {
  let root: string
  let vfs: ReturnType<typeof createVFS>

  beforeEach(async () => {
    root = await createTempDir()
    vfs = createVFS({
      backend: new FilesystemBackend({ rootDir: root }),
      execute: ['node'],
    })
  })

  afterEach(async () => {
    await cleanupTempDir(root)
  })

  it('should write and read a file', async () => {
    expectOkResult(await vfs.write_file('/f.txt', 'hello fs'))
    expect(await readAll(expectOkResult(await vfs.read_file('/f.txt')).data)).toBe('hello fs')
  })

  it('should execute a command', async () => {
    await vfs.write_file('/echo.js', 'process.stdout.write("ok")')
    const ok = expectOkResult(await vfs.execute('node', { args: ['echo.js'] }))
    expect(ok.data.stdout).toContain('ok')
    expect(ok.data.exitCode).toBe(0)
  })

  it('should reject affected paths that escape the root', async () => {
    expect(expectErrResult(await vfs.execute('node', { args: ['x.js'], affectedPaths: ['../outside'] })).code).toBe('PATH_TRAVERSAL')
    // Host drive paths are legal; a backslash in a virtual path is not.
    expect(expectErrResult(await vfs.execute('node', { args: ['x.js'], affectedPaths: ['/ok', 'a\\b'] })).code).toBe('INVALID_PATH')
  })

  it('should surface declared scope and affected paths in meta', async () => {
    await vfs.write_file('/echo.js', 'process.stdout.write("ok")')
    const ok = expectOkResult(await vfs.execute('node', { args: ['echo.js'], scope: 'readwrite', affectedPaths: ['/a.txt', '/sub/b.txt'] }))
    expect(ok.meta.scope).toBe('readwrite')
    expect(ok.meta.affectedPaths).toEqual(['/a.txt', '/sub/b.txt'])
  })

  it('should accept an execute op object directly (overload)', async () => {
    // execute(op) is narrowed to ExecuteOp — the result type is fixed as
    // ExecuteResult, so no generic pin is needed.
    await vfs.write_file('/overload.js', 'process.stdout.write("op-overload")')
    const ok = expectOkResult(await vfs.execute({
      kind: OP_KIND.EXECUTE,
      id: 'custom-id',
      command: 'node',
      args: ['overload.js'],
    }))
    expect(ok.data.stdout).toContain('op-overload')
  })

  it('should reject a cwd that escapes the root', async () => {
    expect(expectErrResult(await vfs.execute('node', { args: ['x.js'], cwd: '../outside' })).code).toBe('PATH_TRAVERSAL')
  })

  it('should reject a backslash host cwd in virtual mode', async () => {
    // Regression: a backslash drive path (e.g. "C:\dir") used to slip past
    // path validation (cwd bypassed validatePath), then fail with
    // "Working directory does not exist" instead of a sandbox rejection.
    const vm = createVFS({ backend: new FilesystemBackend({ rootDir: root, virtualMode: true }), execute: ['node'] })
    expect(expectErrResult(await vm.execute('node', { args: ['x.js'], cwd: 'C:\\some\\dir' })).code).toBe('PATH_TRAVERSAL')
  })

  it.skipIf(process.platform !== 'win32')('should resolve a backslash host cwd in default mode (Windows)', async () => {
    // Regression: a backslash drive cwd used to be treated as a virtual path
    // (NOT_FOUND under rootDir) instead of the real host directory.
    const script = join(tmpdir(), `vfs-cwd-${Date.now()}.js`)
    await fsp.writeFile(script, 'process.stdout.write(process.cwd())', 'utf8')
    try {
      const ok = expectOkResult(await vfs.execute('node', { args: [script], cwd: tmpdir() }))
      expect(ok.data.stdout).toContain('Temp')
    }
    finally {
      await fsp.rm(script, { force: true })
    }
  })

  it('should ls a directory', async () => {
    await vfs.write_file('/a.txt', 'x')
    await vfs.write_file('/b.txt', 'y')
    expect(expectOkResult(await vfs.ls('/')).data.entries).toHaveLength(2)
  })

  describe('relative paths', () => {
    it('should write and read via a relative path', async () => {
      const w = await vfs.write_file('notes.md', '# hello')
      const ok = expectOkResult(w)
      // Result path keeps the user-supplied form.
      expect(ok.data.path).toBe('notes.md')

      expect(await readAll(expectOkResult(await vfs.read_file('notes.md')).data)).toBe('# hello')
    })

    it('should keep virtual absolute and relative forms pointing at the same file', async () => {
      await vfs.write_file('/src/app.ts', 'export const x = 1')
      expectOkResult(await vfs.read_file('src/app.ts'))
    })

    it('should reject relative paths that escape the root', async () => {
      expect(expectErrResult(await vfs.read_file('../etc/passwd')).code).toBe('PATH_TRAVERSAL')
    })

    it('should normalize duplicate slashes in relative paths', async () => {
      expectOkResult(await vfs.write_file('src//app.ts', 'x'))
      expectOkResult(await vfs.read_file('src/app.ts'))
    })

    it('should treat . as the root directory', async () => {
      await vfs.write_file('/root-file.txt', 'x')
      const ok = expectOkResult(await vfs.ls('.'))
      expect(ok.data.entries.some(e => e.name === 'root-file.txt')).toBe(true)
    })

    it('should refuse to delete the root via ./ or .', async () => {
      await vfs.write_file('/keep.txt', 'x')
      // Regression: `./` used to survive as `./` (not `/`) and bypass the
      // "cannot delete root" guard in the delete handler.
      for (const p of ['./', '.']) {
        expect(expectErrResult(await vfs.delete_file(p, { recursive: true })).code).toBe('PERMISSION_DENIED')
      }
      expectOkResult(await vfs.read_file('/keep.txt'))
    })

    it('should mkdir via a relative path under rootDir', async () => {
      expect(expectOkResult(await vfs.mkdir('sub/dir')).data.wasCreated).toBe(true)
      // Same physical directory, visible via the virtual absolute path too.
      const ls = expectOkResult(await vfs.ls('/sub'))
      expect(ls.data.entries.some(e => e.name === 'dir')).toBe(true)
    })
  })

  describe('virtualMode', () => {
    it('should reject host absolute paths in virtual mode', async () => {
      const vm = createVFS({ backend: new FilesystemBackend({ rootDir: root, virtualMode: true }) })
      const r = expectErrResult(await vm.write_file('C:/escaped.txt', 'x'))
      expect(r.code).toBe('PATH_TRAVERSAL')
      expect(r.error).toContain('Host path not allowed in virtual mode')
    })

    it('should reject host paths in mkdir in virtual mode', async () => {
      const vm = createVFS({ backend: new FilesystemBackend({ rootDir: root, virtualMode: true }) })
      const r = expectErrResult(await vm.mkdir('C:/escaped-dir'))
      expect(r.code).toBe('PATH_TRAVERSAL')
      expect(r.error).toContain('Host path not allowed in virtual mode')
    })

    it('should report path traversal (not host-path) for host paths with ..', async () => {
      // A host path containing '..' is rejected by validatePath before
      // reaching the backend — the cause is '..' traversal, not virtualMode
      // rejection. The error message must say "Path traversal rejected",
      // not "Host path not allowed in virtual mode".
      const vm = createVFS({ backend: new FilesystemBackend({ rootDir: root, virtualMode: true }) })
      const r = expectErrResult(await vm.read_file('C:/foo/../bar'))
      expect(r.code).toBe('PATH_TRAVERSAL')
      expect(r.error).toContain('Path traversal rejected')
      expect(r.error).not.toContain('Host path not allowed')
    })
  })
})
