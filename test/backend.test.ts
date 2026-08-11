/**
 * Backend tests: InMemoryBackend + FilesystemBackend.
 */
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesystemBackend } from '../packages/node-vfs/src/backend/filesystem'
import { InMemoryBackend } from '../packages/node-vfs/src/backend/memory'
import { readAll } from './helpers'
import { cleanupTempDir, createTempDir } from './setup'

const OVERWRITE = 'overwrite'

// ── InMemoryBackend ────────────────────────────────────────────────────────

describe('inMemoryBackend', () => {
  let backend: InMemoryBackend

  beforeEach(() => {
    backend = new InMemoryBackend()
  })

  describe('write + read', () => {
    it('should write and read a file', async () => {
      const data = new TextEncoder().encode('hello')
      await backend.write('/file.txt', data, OVERWRITE)
      const stat = await backend.stat('/file.txt')
      expect(stat).not.toBeNull()
      expect(stat!.size).toBe(5)

      expect(await readAll(backend.read('/file.txt'))).toBe('hello')
    })

    it('should support range read', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('abcdef'), OVERWRITE)
      expect(await readAll(backend.read('/f.txt', { start: 1, end: 4 }))).toBe('bcd')
    })

    it('should support create mode', async () => {
      await backend.write('/new.txt', new TextEncoder().encode('new'), 'create')
      expect(await backend.stat('/new.txt')).not.toBeNull()
    })

    // `create` rejects with ALREADY_EXISTS when the file exists — this is
    // handler-level contract logic, already covered in handlers.test.ts
    // (handleWriteFile → ALREADY_EXISTS). The FilesystemBackend mirror below
    // stays because it also exercises the atomic-write path on disk.

    it('should support append mode', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('ab'), OVERWRITE)
      await backend.write('/f.txt', new TextEncoder().encode('cd'), 'append')
      expect(await readAll(backend.read('/f.txt'))).toBe('abcd')
    })

    it('should report deltaBytes for overwrite vs append', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('abc'), OVERWRITE)
      const overwrite = await backend.write('/f.txt', new TextEncoder().encode('x'), OVERWRITE)
      expect(overwrite.deltaBytes).toBe(-2)
      const append = await backend.write('/f.txt', new TextEncoder().encode('yz'), 'append')
      expect(append.deltaBytes).toBe(2)
    })
  })

  describe('stat', () => {
    it('should treat implicit parent directories as directories', async () => {
      await backend.write('/a/b/c.txt', new TextEncoder().encode('x'), OVERWRITE)
      expect((await backend.stat('/a'))?.isDirectory).toBe(true)
      expect((await backend.stat('/a/b'))?.isDirectory).toBe(true)
      expect((await backend.stat('/a/b/c.txt'))?.isDirectory).toBe(false)
    })

    it('should return null for missing paths', async () => {
      expect(await backend.stat('/nope')).toBeNull()
      expect(await backend.stat('/a/nope.txt')).toBeNull()
    })
  })

  describe('remove', () => {
    it('should remove a file', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      await backend.remove('/f.txt')
      expect(await backend.stat('/f.txt')).toBeNull()
    })

    it('should reject removing directory without recursive', async () => {
      await backend.write('/dir/f.txt', new Uint8Array([1]), OVERWRITE)
      await expect(backend.remove('/dir')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    })

    it('should remove directory recursively', async () => {
      await backend.write('/dir/f.txt', new Uint8Array([1]), OVERWRITE)
      const result = await backend.remove('/dir', true)
      expect(result.wasDirectory).toBe(true)
      expect(result.bytesFreed).toBeGreaterThan(0)
    })

    it('should throw NOT_FOUND for missing paths', async () => {
      await expect(backend.remove('/noexist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('listDir', () => {
    it('should list directory entries', async () => {
      await backend.write('/a.txt', new Uint8Array([1]), OVERWRITE)
      await backend.write('/b.txt', new Uint8Array([2]), OVERWRITE)
      expect((await backend.listDir('/')).sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('should return empty for non-existent directory', async () => {
      expect(await backend.listDir('/nonexistent')).toEqual([])
    })

    it('should return empty for an empty directory', async () => {
      await backend.mkdir('/empty')
      expect(await backend.listDir('/empty')).toEqual([])
    })
  })

  describe('mkdir', () => {
    it('should create a directory recursively', async () => {
      const r = await backend.mkdir('/a/b/c')
      expect(r.wasCreated).toBe(true)
      expect((await backend.stat('/a/b/c'))?.isDirectory).toBe(true)
      expect((await backend.stat('/a/b'))?.isDirectory).toBe(true)
    })

    it('should be idempotent for existing directories', async () => {
      await backend.mkdir('/dir')
      const r = await backend.mkdir('/dir')
      expect(r.wasCreated).toBe(false)
    })

    it('should reject when a file exists at the path', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      await expect(backend.mkdir('/f.txt')).rejects.toMatchObject({ code: 'NOT_DIRECTORY' })
    })
  })

  describe('globFiles', () => {
    it('should match files by pattern', async () => {
      await backend.write('/src/a.ts', new Uint8Array([1]), OVERWRITE)
      await backend.write('/src/b.ts', new Uint8Array([2]), OVERWRITE)
      await backend.write('/src/c.js', new Uint8Array([3]), OVERWRITE)
      const files = await backend.globFiles('/src', '**/*.ts')
      const names = files.map(f => f.replace(/\\/g, '/').split('/').pop())
      expect(names).toContain('a.ts')
      expect(names).toContain('b.ts')
      expect(names).not.toContain('c.js')
    })

    it('should return empty for no matches', async () => {
      expect(await backend.globFiles('/', '*.nonexistent')).toEqual([])
    })
  })

  describe('readLines', () => {
    it('should yield lines', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('line1\nline2\nline3'), OVERWRITE)
      const lines: string[] = []
      for await (const l of backend.readLines('/f.txt')) {
        lines.push(l.text)
      }
      expect(lines).toEqual(['line1', 'line2', 'line3'])
    })

    it('should set truncated for large files', async () => {
      // Create a file just over 4MB
      const size = 4 * 1024 * 1024 + 100
      const content = new Uint8Array(size).fill(65) // 'A'
      await backend.write('/big.txt', content, OVERWRITE)
      const lines: { text: string, truncated?: boolean }[] = []
      for await (const l of backend.readLines('/big.txt')) {
        lines.push(l)
      }
      expect(lines.length).toBeGreaterThan(0)
      expect(lines[lines.length - 1]!.truncated).toBe(true)
    })
  })

  describe('concurrency', () => {
    it('should handle concurrent writes to the same path', async () => {
      // Concurrent writes race — final result should be one of them.
      await Promise.all([
        backend.write('/f.txt', new TextEncoder().encode('aaa'), OVERWRITE),
        backend.write('/f.txt', new TextEncoder().encode('bbb'), OVERWRITE),
      ])
      const content = await readAll(backend.read('/f.txt'))
      // It should be one of the two values, not a mix.
      expect(['aaa', 'bbb']).toContain(content)
    })
  })

  describe('dispose', () => {
    it('should clear all state', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      await backend.dispose()
      expect(await backend.stat('/f.txt')).toBeNull()
      expect(await backend.stat('/')).not.toBeNull() // root re-added
    })
  })
})

// ── FilesystemBackend ──────────────────────────────────────────────────────

describe('filesystemBackend', () => {
  let root: string
  let backend: FilesystemBackend

  beforeEach(async () => {
    root = await createTempDir()
    backend = new FilesystemBackend({ rootDir: root })
  })

  afterEach(async () => {
    await cleanupTempDir(root)
  })

  describe('write + read', () => {
    it('should write and read a file', async () => {
      await backend.write('/file.txt', new TextEncoder().encode('hello world'), OVERWRITE)
      const stat = await backend.stat('/file.txt')
      expect(stat).not.toBeNull()
      expect(stat!.size).toBe(11)

      expect(await readAll(backend.read('/file.txt'))).toBe('hello world')
    })

    it('should support append', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('ab'), OVERWRITE)
      await backend.write('/f.txt', new TextEncoder().encode('cd'), 'append')
      expect(await readAll(backend.read('/f.txt'))).toBe('abcd')
    })

    it('should reject create when file exists', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), 'create')
      await expect(
        backend.write('/f.txt', new Uint8Array([2]), 'create'),
      ).rejects.toThrow()
    })

    it('should not leave temp or backup artifacts behind', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('one'), OVERWRITE)
      await backend.write('/f.txt', new TextEncoder().encode('two'), 'append')
      await backend.write('/f.txt', new TextEncoder().encode('three'), OVERWRITE)
      const entries = await fsp.readdir(root)
      expect(entries).toEqual(['f.txt'])
    })
  })

  describe('remove', () => {
    it('should remove a file', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      await backend.remove('/f.txt')
      expect(await backend.stat('/f.txt')).toBeNull()
    })

    it('should remove directory recursively', async () => {
      await backend.write('/dir/f.txt', new Uint8Array([1]), OVERWRITE)
      await backend.remove('/dir', true)
      expect(await backend.stat('/dir')).toBeNull()
    })

    it('should report the whole subtree byte count when deleting a directory', async () => {
      await backend.write('/dir/a.txt', new Uint8Array(10), OVERWRITE)
      await backend.write('/dir/sub/b.txt', new Uint8Array(5), OVERWRITE)
      await backend.write('/dir/sub/c.txt', new Uint8Array(7), OVERWRITE)
      const r = await backend.remove('/dir', true)
      expect(r.wasDirectory).toBe(true)
      expect(r.bytesFreed).toBe(22)
    })

    it('should throw for non-existent path', async () => {
      await expect(backend.remove('/noexist')).rejects.toThrow()
    })
  })

  describe('path traversal protection', () => {
    it('should reject .. in path', async () => {
      await expect(
        backend.write('/../outside', new Uint8Array([1]), OVERWRITE),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })
  })

  describe('listDir', () => {
    it('should list directory entries', async () => {
      await backend.write('/a.txt', new Uint8Array([1]), OVERWRITE)
      await backend.write('/b.txt', new Uint8Array([2]), OVERWRITE)
      const entries = await backend.listDir('/')
      const normalized = entries.map(e => e.replace(/\\/g, '/'))
      expect(normalized).toContain('a.txt')
      expect(normalized).toContain('b.txt')
    })

    it('should hide VFS internal tmp/backup artifacts', async () => {
      // Simulate a crashed atomic write leaving an orphan behind.
      await fsp.writeFile(`${root}/.vfs-tmp.orphan`, 'x')
      await fsp.writeFile(`${root}/f.vfs-tmp.orphan.bak`, 'x')
      await backend.write('/real.txt', new Uint8Array([1]), OVERWRITE)
      const entries = await backend.listDir('/')
      expect(entries).toEqual(['real.txt'])
    })
  })

  describe('symlink escape detection', () => {
    // Symlinks require privileges on Windows — run on POSIX only.
    describe.skipIf(process.platform === 'win32')('posix', () => {
      it('should reject stat through a symlink pointing outside root', async () => {
        const { join } = await import('node:path')
        const outside = join(tmpdir(), `vfs-symlink-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fsp.mkdir(outside, { recursive: true })
        const link = join(root, 'escape-link')
        try {
          await fsp.symlink(outside, link, 'dir')
          await expect(backend.stat('/escape-link')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
          await expect(backend.listDir('/escape-link')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
        }
        finally {
          await fsp.rm(outside, { recursive: true, force: true })
          await fsp.rm(link, { recursive: true, force: true })
        }
      })

      it('should reject writes through a symlinked parent directory', async () => {
        const { join } = await import('node:path')
        const outside = join(tmpdir(), `vfs-symlink-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fsp.mkdir(outside, { recursive: true })
        const link = join(root, 'linkdir')
        try {
          await fsp.symlink(outside, link, 'dir')
          await expect(
            backend.write('/linkdir/f.txt', new Uint8Array([1]), OVERWRITE),
          ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
        }
        finally {
          await fsp.rm(outside, { recursive: true, force: true })
          await fsp.rm(link, { recursive: true, force: true })
        }
      })
    })
  })

  describe('permission errors', () => {
    it('should map stat EACCES to PERMISSION_DENIED', async () => {
      await backend.write('/sub/f.txt', new Uint8Array([1]), OVERWRITE)
      const spy = vi.spyOn(fsp, 'stat').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
      try {
        await expect(backend.stat('/sub/f.txt')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      }
      finally {
        spy.mockRestore()
      }
    })

    it('should map path-component lstat EACCES to PERMISSION_DENIED', async () => {
      const spy = vi.spyOn(fsp, 'lstat').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
      try {
        await expect(backend.stat('/deep/nested/path')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      }
      finally {
        spy.mockRestore()
      }
    })

    it('should map atomic write rename EPERM to PERMISSION_DENIED', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
      )
      try {
        await expect(
          backend.write('/f.txt', new Uint8Array([2]), OVERWRITE),
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      }
      finally {
        spy.mockRestore()
      }
    })
  })

  describe('execute', () => {
    it('should execute a command and return stdout', async () => {
      const result = await backend.execute({
        command: 'node',
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: '/',
        env: {},
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('ok')
    })

    it('should detect truncation', async () => {
      // Generate a command that outputs more than maxOutputBytes.
      // With reject:false, execa caps output at maxBuffer and we mark
      // truncated: true when (stdout+stderr) bytes reach maxOutputBytes.
      // `truncated` is derived from byte threshold, not exitCode, so it must
      // hold regardless of EPIPE-induced non-zero exit on Windows.
      const js = 'process.stdout.write("x".repeat(200000))'
      const result = await backend.execute({
        command: 'node',
        args: ['-e', js],
        cwd: '/',
        env: {},
        timeoutMs: 5000,
        maxOutputBytes: 100,
        signal: new AbortController().signal,
      })
      expect(result.truncated).toBe(true)
    })

    it('should return non-zero exitCode', async () => {
      const result = await backend.execute({
        command: 'node',
        args: ['-e', 'process.exit(42)'],
        cwd: '/',
        env: {},
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(42)
    })

    it('should time out long-running commands', async () => {
      const result = await backend.execute({
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 10_000)'],
        cwd: '/',
        env: {},
        timeoutMs: 200,
        maxOutputBytes: 1024 * 1024,
        signal: new AbortController().signal,
      })
      expect(result.timedOut).toBe(true)
    })

    it('should surface mid-execution cancellation as ABORTED', async () => {
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 150)
      await expect(backend.execute({
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: '/',
        env: {},
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
        signal: ac.signal,
      })).rejects.toMatchObject({ code: 'ABORTED' })
    })
  })

  describe('readLines', () => {
    it('should yield lines', async () => {
      await backend.write('/f.txt', new TextEncoder().encode('a\nb\nc'), OVERWRITE)
      const lines: string[] = []
      for await (const l of backend.readLines('/f.txt')) {
        lines.push(l.text)
      }
      expect(lines).toEqual(['a', 'b', 'c'])
    })

    it('should set truncated for large files', async () => {
      const size = 4 * 1024 * 1024 + 100
      const content = new Uint8Array(size).fill(65)
      await backend.write('/big.txt', content, OVERWRITE)
      const lines: { text: string, truncated?: boolean }[] = []
      for await (const l of backend.readLines('/big.txt')) {
        lines.push(l)
      }
      expect(lines.length).toBeGreaterThan(0)
      expect(lines[lines.length - 1]!.truncated).toBe(true)
    })
  })

  describe('globFiles', () => {
    it('should match files', async () => {
      await backend.write('/x.ts', new Uint8Array([1]), OVERWRITE)
      await backend.write('/y.js', new Uint8Array([2]), OVERWRITE)
      const files = await backend.globFiles('/', '**/*.ts')
      const normalized = files.map(f => f.replace(/\\/g, '/').replace(/^(?!\/)/, '/'))
      expect(normalized).toContain('/x.ts')
      expect(normalized).not.toContain('/y.js')
    })

    it('should filter matches that escape the sandbox root', async () => {
      // fastGlob happily matches '../file' from a cwd inside rootDir; the
      // backend must never surface such matches (defense in depth — handleGlob
      // rejects the pattern earlier).
      const name = `escape-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
      const outside = join(root, '..', name)
      await fsp.writeFile(outside, 'secret', 'utf8')
      try {
        const files = await backend.globFiles('/', `../${name}`)
        expect(files).toEqual([])
      }
      finally {
        await fsp.rm(outside, { force: true })
      }
    })
  })

  describe('mkdir', () => {
    it('should create a directory recursively', async () => {
      const r = await backend.mkdir('/deep/nested/dir')
      expect(r.wasCreated).toBe(true)
      expect((await backend.stat('/deep/nested/dir'))?.isDirectory).toBe(true)
    })

    it('should be idempotent for existing directories', async () => {
      await backend.mkdir('/dir')
      const r = await backend.mkdir('/dir')
      expect(r.wasCreated).toBe(false)
    })

    it('should reject when a file exists at the path', async () => {
      await backend.write('/f.txt', new Uint8Array([1]), OVERWRITE)
      await expect(backend.mkdir('/f.txt')).rejects.toMatchObject({ code: 'NOT_DIRECTORY' })
    })

    it('should reject host paths in virtual mode', async () => {
      const vm = new FilesystemBackend({ rootDir: root, virtualMode: true })
      await expect(vm.mkdir('C:/escaped')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })
  })

  describe('relative paths', () => {
    it('should resolve relative paths under rootDir', async () => {
      await backend.write('rel.txt', new TextEncoder().encode('rel'), OVERWRITE)
      expect(await backend.stat('/rel.txt')).not.toBeNull()

      expect(await readAll(backend.read('rel.txt'))).toBe('rel')
    })

    it('should allow mixed relative / virtual absolute access to the same file', async () => {
      await backend.write('/sub/deep.txt', new TextEncoder().encode('deep'), OVERWRITE)
      expect(await backend.stat('sub/deep.txt')).not.toBeNull()

      expect(await readAll(backend.read('sub/deep.txt'))).toBe('deep')
    })

    it('should list a directory via a relative path', async () => {
      await backend.write('/sub/a.txt', new Uint8Array([1]), OVERWRITE)
      const entries = await backend.listDir('sub')
      expect(entries).toContain('a.txt')
    })

    it('should execute with a relative cwd', async () => {
      await backend.write('/sub/ok.txt', new TextEncoder().encode('ok'), OVERWRITE)
      const result = await backend.execute({
        command: 'node',
        args: ['-e', 'process.stdout.write(process.cwd().split(/[\\\\/]/).pop())'],
        cwd: 'sub',
        env: {},
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('sub')
    })

    it('should reject escaping relative paths even when all components exist', async () => {
      // Create a real directory next to rootDir. A naive join(root, '../x')
      // resolves to an existing path, which the symlink-walk alone would
      // let through — only the final assertInsideRoot catches it.
      const { join } = await import('node:path')
      const outside = join(tmpdir(), 'vfs-outside-dir')
      await fsp.mkdir(outside, { recursive: true })
      try {
        const escaping = '../vfs-outside-dir'
        await expect(backend.stat(escaping)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
        await expect(backend.listDir(escaping)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
      }
      finally {
        await fsp.rm(outside, { recursive: true, force: true })
      }
    })
  })

  describe('virtualMode', () => {
    let vmBackend: FilesystemBackend

    beforeEach(async () => {
      vmBackend = new FilesystemBackend({ rootDir: root, virtualMode: true })
    })

    it('should resolve relative paths under rootDir', async () => {
      await vmBackend.write('rel.txt', new TextEncoder().encode('rel'), OVERWRITE)
      expect(await vmBackend.stat('/rel.txt')).not.toBeNull()
    })

    it('should reject host absolute paths', async () => {
      await expect(
        vmBackend.write('C:/escaped.txt', new Uint8Array([1]), OVERWRITE),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })

    it('should reject host absolute path reads', async () => {
      await expect(vmBackend.stat('C:/nonexistent.txt')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })
  })

  describe('root boundary handling', () => {
    // Precompute the drive-root layout flag so `it.skipIf` surfaces the skip
    // in the test report (silent `return` hides which tests never ran on CI).
    const driveRoot = `${tmpdir().replace(/\\/g, '/').split('/')[0]}/`
    const isDriveRootLayout = /^[a-z]:\/$/i.test(driveRoot)

    it.skipIf(!isDriveRootLayout)('should not reject children when rootDir is a drive root (Windows)', async () => {
      // Regression test for the assertInsideRoot boundary bug: a root ending
      // with a separator (`C:/`) used to make every child path fail the prefix
      // match. stat() of a non-existent child returns null when resolution
      // succeeds, or throws PATH_TRAVERSAL when the boundary check misfires.
      const rb = new FilesystemBackend({ rootDir: driveRoot })
      const stat = await rb.stat(`/${Math.random().toString(36).slice(2)}-nonexistent.txt`)
      expect(stat).toBeNull()
    })

    it.skipIf(process.platform === 'win32')('should not reject children when rootDir is the posix root (POSIX)', async () => {
      const rb = new FilesystemBackend({ rootDir: '/' })
      const stat = await rb.stat(`/${Math.random().toString(36).slice(2)}-nonexistent.txt`)
      expect(stat).toBeNull()
    })
  })

  describe('host absolute paths (default mode)', () => {
    it('should treat drive-style paths as host paths (not under rootDir)', async () => {
      // A drive path is not mapped under rootDir — stat must not find a file
      // that only exists under rootDir. Use a path that cannot exist as-is.
      await backend.write('/x.txt', new Uint8Array([1]), OVERWRITE)
      const drivePath = `C:/__node_vfs_nonexistent__/${Math.random().toString(36).slice(2)}.txt`
      const stat = await backend.stat(drivePath)
      expect(stat).toBeNull()
    })
  })

  describe.skipIf(process.platform !== 'win32')('host absolute path bypass (Windows)', () => {
    it('should read a real host directory outside rootDir', async () => {
      const hostTmp = tmpdir().replace(/\\/g, '/') // e.g. C:/Users/.../Temp
      const stat = await backend.stat(hostTmp)
      // If the path had been mapped under rootDir it would not exist.
      expect(stat).not.toBeNull()
      expect(stat!.isDirectory).toBe(true)
    })

    it('should write outside rootDir when not in virtualMode', async () => {
      const { join } = await import('node:path')
      const hostFile = join(tmpdir(), `node-vfs-host-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
        .replace(/\\/g, '/')
      try {
        const receipt = await backend.write(hostFile, new TextEncoder().encode('host'), OVERWRITE)
        expect(receipt.bytesWritten).toBe(4)
        // Not visible under rootDir.
        const rootStat = await backend.stat(`/${hostFile.replace(/^[a-z]:/i, '')}`)
        expect(rootStat).toBeNull()
        // Readable back via the host path.
        expect(await readAll(backend.read(hostFile))).toBe('host')
      }
      finally {
        await fsp.rm(hostFile, { force: true })
      }
    })
  })
})
