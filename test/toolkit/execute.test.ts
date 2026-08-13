import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemBackend } from '../../packages/node-vfs/src/backend/filesystem'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { executeTool } from '../../packages/toolkit/src/tools/execute'
import { cleanupTempDir, createTempDir } from '../setup'

describe('executeTool', () => {
  it('should return UNSUPPORTED for InMemoryBackend', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    const toolkit = new VFSToolkit(vfs)
    await expect(
      toolkit.executeTool(executeTool, { command: 'echo', args: ['hi'] }),
    ).rejects.toThrow('execute failed: UNSUPPORTED')
  })

  describe('with FilesystemBackend', () => {
    let root: string
    let vfs: ReturnType<typeof createVFS>
    let toolkit: VFSToolkit

    beforeEach(async () => {
      root = await createTempDir()
      // execute is default-deny; allow node for script runs.
      vfs = createVFS({
        backend: new FilesystemBackend({ rootDir: root }),
        execute: { allowCommands: ['node'] },
      })
      toolkit = new VFSToolkit(vfs)
    })

    afterEach(async () => {
      await cleanupTempDir(root)
    })

    it('should execute a real command and return stdout', async () => {
      await vfs.write_file('/echo.js', 'process.stdout.write("tool-ok")')
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['echo.js'],
      })
      expect(out).toContain('tool-ok')
    })

    it('should append exit code and stderr on non-zero exit', async () => {
      await vfs.write_file('/fail.js', 'process.stderr.write("boom"); process.exit(3)')
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['fail.js'],
      })
      expect(out).toContain('[Command exited with code 3]')
      expect(out).toContain('boom')
    })

    it('should honour the cwd parameter', async () => {
      await vfs.write_file('/sub/marker.txt', 'present')
      await vfs.write_file('/sub/check.js', 'const fs=require("fs"); process.stdout.write(fs.existsSync("marker.txt") ? "found" : "missing")')
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['check.js'],
        cwd: '/sub',
      })
      expect(out).toContain('found')
    })

    it('should accept all optional parameters', async () => {
      await vfs.write_file('/env.js', 'process.stdout.write(process.env.INJECTED ?? "")')
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['env.js'],
        env: { INJECTED: 'env-ok' },
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
      })
      expect(out).toContain('env-ok')
    })

    it('should allow inline-code eval forms once the interpreter is allowed', async () => {
      // EVAL_ARGS was removed: the guard trusts the allow-listed command
      // entirely, so `node -e` (like `node script.js`) runs any code.
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['-e', 'process.stdout.write("inline-ok")'],
      })
      expect(out).toContain('inline-ok')
    })

    it('should surface permission errors when execute is not allowed', async () => {
      // A VFS without an execute allow-list rejects every command (default-deny).
      const vfs2 = createVFS({ backend: new FilesystemBackend({ rootDir: root }) })
      const toolkit2 = new VFSToolkit(vfs2)
      await expect(
        toolkit2.executeTool(executeTool, { command: 'node', args: ['echo.js'] }),
      ).rejects.toThrow(/execute failed: PERMISSION_DENIED|disabled by default|permission/i)
      await vfs2.dispose()
    })

    it('should pass through scope and affectedPaths to the VFS', async () => {
      await vfs.write_file('/sub/echo.js', 'process.stdout.write("ok")')
      const out = await toolkit.executeTool(executeTool, {
        command: 'node',
        args: ['echo.js'],
        cwd: '/sub',
        scope: 'readwrite',
        affectedPaths: ['/sub/out.txt'],
      })
      expect(out).toContain('ok')
    })

    it('should reject a full command line stuffed into "command"', async () => {
      await vfs.write_file('/echo.js', 'process.stdout.write("x")')
      await expect(
        toolkit.executeTool(executeTool, { command: 'node echo.js' }),
      ).rejects.toThrow(/args/)
    })

    it('should surface stderr even when the exit code is 0', async () => {
      await vfs.write_file('/warn.js', 'process.stderr.write("warn-msg")')
      const out = await toolkit.executeTool(executeTool, { command: 'node', args: ['warn.js'] })
      expect(out).toContain('Stderr: warn-msg')
    })

    it('should report a visible placeholder when a command produces no output', async () => {
      await vfs.write_file('/silent.js', '')
      const out = await toolkit.executeTool(executeTool, { command: 'node', args: ['silent.js'] })
      expect(out).toContain('[Command produced no output')
    })

    it.skipIf(process.platform !== 'win32')('should run a cmd builtin by action name', async () => {
      // The allow-list names the action ("echo"), not the interpreter. The
      // VFS dispatches the builtin through cmd itself when no executable
      // resolves; Git Bash's /usr/bin/echo.exe makes the direct-spawn path
      // equally valid — both must return the output.
      const vfs2 = createVFS({ backend: new FilesystemBackend({ rootDir: root }), execute: { allowCommands: ['echo'] } })
      const tk2 = new VFSToolkit(vfs2)
      try {
        const out = await tk2.executeTool(executeTool, { command: 'echo', args: ['tool-builtin-ok'] })
        expect(out).toContain('tool-builtin-ok')
      }
      finally {
        await vfs2.dispose()
      }
    })
  })
})
