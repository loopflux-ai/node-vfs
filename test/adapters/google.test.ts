import { beforeEach, describe, expect, it } from 'vitest'
import { toGoogleTools } from '../../packages/adapters/google/src/adapter'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'

describe('toGoogleTools', () => {
  let vfs: ReturnType<typeof createVFS>

  beforeEach(() => {
    vfs = createVFS({ backend: new InMemoryBackend() })
  })

  it('should return 9 FunctionTools by default', () => {
    const tools = toGoogleTools(vfs)
    expect(tools).toHaveLength(9)
    const names = tools.map(t => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('delete_file')
    expect(names).toContain('grep')
    expect(names).toContain('ls')
    expect(names).toContain('glob')
    expect(names).toContain('mkdir')
    expect(names).toContain('execute')
  })

  it('should apply prefix to tool names', () => {
    const tools = toGoogleTools(vfs, { prefix: 'vfs_' })
    expect(tools.every(t => t.name.startsWith('vfs_'))).toBe(true)
    expect(tools[0]?.name).toBe('vfs_read_file')
  })

  it('should filter tools', () => {
    const tools = toGoogleTools(vfs, {
      filter: name => name !== 'execute',
    })
    expect(tools).toHaveLength(8)
    expect(tools.map(t => t.name)).not.toContain('execute')
  })

  it('should combine prefix and filter', () => {
    const tools = toGoogleTools(vfs, {
      prefix: 'fs_',
      filter: name => name === 'read_file',
    })
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('fs_read_file')
  })

  it('should include description in tools', () => {
    const tools = toGoogleTools(vfs)
    const readFile = tools.find(t => t.name === 'read_file')
    expect(readFile?.description).toBeDefined()
    expect(typeof readFile?.description).toBe('string')
    expect(readFile!.description.length).toBeGreaterThan(0)
  })

  it('should execute adapted read_file tool', async () => {
    await vfs.write_file('/test.txt', 'hello google')
    const tools = toGoogleTools(vfs, { filter: n => n === 'read_file' })
    const result = await tools[0]!.runAsync({
      args: { path: '/test.txt' },
      toolContext: {} as any,
    })
    expect(result).toBe('hello google')
  })

  it('should execute adapted write_file tool', async () => {
    const tools = toGoogleTools(vfs, { filter: n => n === 'write_file' })
    const result = await tools[0]!.runAsync({
      args: { path: '/new.txt', content: 'written' },
      toolContext: {} as any,
    })
    expect(result).toContain('Wrote')
    expect(result).toContain('/new.txt')
  })

  it('should propagate errors from toolkit', async () => {
    const tools = toGoogleTools(vfs, { filter: n => n === 'read_file' })
    await expect(
      tools[0]!.runAsync({
        args: { path: '/noexist' },
        toolContext: {} as any,
      }),
    ).rejects.toThrow('read_file failed: NOT_FOUND')
  })
})
