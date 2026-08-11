import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { deleteFileTool } from '../../packages/toolkit/src/tools/deleteFile'

describe('deleteFileTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/f.txt', 'hello')
    toolkit = new VFSToolkit(vfs)
  })

  it('should delete a file', async () => {
    const result = await toolkit.executeTool(deleteFileTool, { path: '/f.txt' })
    expect(result).toContain('Deleted file: /f.txt')
  })

  it('should throw on non-existent file', async () => {
    await expect(
      toolkit.executeTool(deleteFileTool, { path: '/noexist' }),
    ).rejects.toThrow('delete_file failed: NOT_FOUND')
  })

  it('should delete directory with recursive flag', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/dir/f.txt', 'x')
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(deleteFileTool, { path: '/dir', recursive: true })
    expect(result).toContain('Deleted directory: /dir')
  })

  it('should reject deleting directory without recursive', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/dir/f.txt', 'x')
    const tk = new VFSToolkit(vfs)
    await expect(
      tk.executeTool(deleteFileTool, { path: '/dir' }),
    ).rejects.toThrow('delete_file failed')
  })
})
