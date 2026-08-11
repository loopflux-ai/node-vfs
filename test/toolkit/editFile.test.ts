import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { editFileTool } from '../../packages/toolkit/src/tools/editFile'

describe('editFileTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/f.txt', 'hello world')
    toolkit = new VFSToolkit(vfs)
  })

  it('should edit file content', async () => {
    const result = await toolkit.executeTool(editFileTool, {
      path: '/f.txt',
      oldText: 'world',
      newText: 'there',
    })
    expect(result).toContain('Replaced 1 occurrence')
  })

  it('should throw when oldText not found', async () => {
    await expect(
      toolkit.executeTool(editFileTool, { path: '/f.txt', oldText: 'xyz', newText: 'new' }),
    ).rejects.toThrow('edit_file failed: OLD_TEXT_NOT_FOUND')
  })

  it('should throw when oldText is empty', async () => {
    await expect(
      toolkit.executeTool(editFileTool, { path: '/f.txt', oldText: '  ', newText: 'new' }),
    ).rejects.toThrow('edit_file failed: OLD_TEXT_EMPTY')
  })

  it('should throw when oldText is ambiguous', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/dup.txt', 'ab ab')
    const tk = new VFSToolkit(vfs)
    await expect(
      tk.executeTool(editFileTool, { path: '/dup.txt', oldText: 'ab', newText: 'cd' }),
    ).rejects.toThrow('edit_file failed: AMBIGUOUS')
  })

  it('should throw on non-existent file', async () => {
    await expect(
      toolkit.executeTool(editFileTool, { path: '/noexist', oldText: 'a', newText: 'b' }),
    ).rejects.toThrow('edit_file failed: NOT_FOUND')
  })
})
