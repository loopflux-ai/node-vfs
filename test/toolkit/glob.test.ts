import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { globTool } from '../../packages/toolkit/src/tools/glob'

describe('globTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/src/a.ts', 'x')
    await vfs.write_file('/src/b.ts', 'y')
    await vfs.write_file('/src/c.js', 'z')
    toolkit = new VFSToolkit(vfs)
  })

  it('should match files by pattern', async () => {
    const result = await toolkit.executeTool(globTool, { path: '/', pattern: '**/*.ts' })
    expect(result).toContain('Found 2 files')
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).not.toContain('c.js')
  })

  it('should report no matches', async () => {
    const result = await toolkit.executeTool(globTool, { path: '/', pattern: '*.nonexistent' })
    expect(result).toContain('No files matched')
  })

  it('should throw on non-existent path', async () => {
    await expect(
      toolkit.executeTool(globTool, { path: '/noexist', pattern: '*' }),
    ).rejects.toThrow('glob failed: NOT_FOUND')
  })

  it('should support pagination via limit', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    for (let i = 0; i < 5; i++) {
      await vfs.write_file(`/f${i}.txt`, 'x')
    }
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(globTool, { path: '/', pattern: '*.txt', limit: 2 })
    expect(result).toContain('more entries exist')
    expect(result).toContain('cursor')
  })

  it('should truncate large output', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    // VFS MAX_LIMIT is 1000. Use very long filenames so each entry line is
    // > 50 chars, pushing the total past 50k.
    const longName = 'x'.repeat(40)
    for (let i = 0; i < 1000; i++) {
      await vfs.write_file(`/${longName}${i.toString().padStart(3, '0')}.ts`, 'x')
    }
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(globTool, { path: '/', pattern: '*.ts', limit: 1000 })
    expect(result).toContain('[Truncated')
  })
})
