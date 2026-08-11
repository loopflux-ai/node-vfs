import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { lsTool } from '../../packages/toolkit/src/tools/ls'

describe('lsTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/a.txt', 'x')
    await vfs.write_file('/b.txt', 'y')
    await vfs.write_file('/dir/c.txt', 'z')
    toolkit = new VFSToolkit(vfs)
  })

  it('should list directory entries', async () => {
    const result = await toolkit.executeTool(lsTool, { path: '/' })
    expect(result).toContain('Entries in /')
    expect(result).toContain('a.txt')
    expect(result).toContain('b.txt')
    expect(result).toContain('dir')
  })

  it('should throw on non-directory', async () => {
    await expect(
      toolkit.executeTool(lsTool, { path: '/a.txt' }),
    ).rejects.toThrow('ls failed: NOT_DIRECTORY')
  })

  it('should respect limit and return cursor', async () => {
    const result = await toolkit.executeTool(lsTool, { path: '/', limit: 1 })
    expect(result).toContain('Entries in /')
    expect(result).toContain('more entries exist')
    expect(result).toContain('cursor')
  })

  it('should throw on non-existent path', async () => {
    await expect(
      toolkit.executeTool(lsTool, { path: '/noexist' }),
    ).rejects.toThrow('ls failed: NOT_FOUND')
  })

  it('should report empty directory', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    // Write then delete to create an empty directory.
    await vfs.write_file('/emptydir/.tmp', '')
    await vfs.delete_file('/emptydir/.tmp')
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(lsTool, { path: '/emptydir' })
    expect(result).toContain('is empty')
  })

  it('should truncate large output', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    // Use long filenames to make each entry line ~100 chars. VFS MAX_LIMIT=1000.
    const longName = 'x'.repeat(60)
    for (let i = 0; i < 1000; i++) {
      await vfs.write_file(`/${longName}${i.toString().padStart(3, '0')}.txt`, 'x')
    }
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(lsTool, { path: '/', limit: 1000 })
    expect(result).toContain('[Truncated')
  })
})
