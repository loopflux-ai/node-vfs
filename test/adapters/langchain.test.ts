import { beforeEach, describe, expect, it } from 'vitest'
import { toLangChainTools } from '../../packages/adapters/langchain/src/adapter'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'

describe('toLangChainTools', () => {
  let vfs: ReturnType<typeof createVFS>

  beforeEach(() => {
    vfs = createVFS({ backend: new InMemoryBackend() })
  })

  it('should adapt all 9 tools by default', () => {
    const tools = toLangChainTools(vfs)
    expect(tools.length).toBe(9)
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

  it('should support prefix and filter options', () => {
    const prefixed = toLangChainTools(vfs, { prefix: 'vfs_' })
    expect(prefixed.every(t => t.name.startsWith('vfs_'))).toBe(true)
    expect(prefixed[0]!.name).toBe('vfs_read_file')

    const filtered = toLangChainTools(vfs, { filter: name => name !== 'execute' })
    expect(filtered.length).toBe(8)
    expect(filtered.map(t => t.name)).not.toContain('execute')

    const combined = toLangChainTools(vfs, { prefix: 'fs_', filter: name => name === 'read_file' })
    expect(combined.length).toBe(1)
    expect(combined[0]!.name).toBe('fs_read_file')
  })

  it('should execute adapted read_file tool', async () => {
    await vfs.write_file('/test.txt', 'hello langchain')
    const tools = toLangChainTools(vfs, { filter: n => n === 'read_file' })
    const result = await tools[0]!.invoke({ path: '/test.txt' })
    expect(result).toBe('hello langchain')
  })

  it('should execute adapted write_file tool', async () => {
    const tools = toLangChainTools(vfs, { filter: n => n === 'write_file' })
    const result = await tools[0]!.invoke({ path: '/new.txt', content: 'written' })
    expect(result).toContain('Wrote')
    expect(result).toContain('/new.txt')
  })

  it('should propagate errors from toolkit', async () => {
    const tools = toLangChainTools(vfs, { filter: n => n === 'read_file' })
    await expect(
      tools[0]!.invoke({ path: '/noexist' }),
    ).rejects.toThrow('read_file failed: NOT_FOUND')
  })
})
