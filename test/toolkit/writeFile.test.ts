import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { writeFileTool } from '../../packages/toolkit/src/tools/writeFile'

describe('writeFileTool', () => {
  let toolkit: VFSToolkit

  beforeEach(() => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    toolkit = new VFSToolkit(vfs)
  })

  it('should write a file', async () => {
    const result = await toolkit.executeTool(writeFileTool, {
      path: '/f.txt',
      content: 'hello',
    })
    expect(result).toContain('Wrote 5 bytes')
    expect(result).toContain('/f.txt')
    expect(result).toContain('overwrite')
  })

  it('should support create mode', async () => {
    const result = await toolkit.executeTool(writeFileTool, {
      path: '/new.txt',
      content: 'fresh',
      mode: 'create',
    })
    expect(result).toContain('Wrote')
    expect(result).toContain('create')
  })

  it('should support append mode', async () => {
    await toolkit.executeTool(writeFileTool, { path: '/f.txt', content: 'ab' })
    const result = await toolkit.executeTool(writeFileTool, {
      path: '/f.txt',
      content: 'cd',
      mode: 'append',
    })
    expect(result).toContain('Wrote 2 bytes')
    expect(result).toContain('append')
  })

  it('should reject create when file exists', async () => {
    await toolkit.executeTool(writeFileTool, { path: '/f.txt', content: 'x', mode: 'create' })
    await expect(
      toolkit.executeTool(writeFileTool, { path: '/f.txt', content: 'y', mode: 'create' }),
    ).rejects.toThrow('write_file failed: ALREADY_EXISTS')
  })

  it('should overwrite by default', async () => {
    await toolkit.executeTool(writeFileTool, { path: '/f.txt', content: 'first' })
    const result = await toolkit.executeTool(writeFileTool, { path: '/f.txt', content: 'second' })
    expect(result).toContain('overwrite')
  })
})
