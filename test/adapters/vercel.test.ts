import { beforeEach, describe, expect, it } from 'vitest'
import { toVercelTools } from '../../packages/adapters/vercel/src/adapter'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'

describe('toVercelTools', () => {
  let vfs: ReturnType<typeof createVFS>

  beforeEach(() => {
    vfs = createVFS({ backend: new InMemoryBackend() })
  })

  it('should return object with 9 tools by default', () => {
    const tools = toVercelTools(vfs)
    expect(Object.keys(tools)).toHaveLength(9)
    expect(tools).toHaveProperty('read_file')
    expect(tools).toHaveProperty('write_file')
    expect(tools).toHaveProperty('edit_file')
    expect(tools).toHaveProperty('delete_file')
    expect(tools).toHaveProperty('grep')
    expect(tools).toHaveProperty('ls')
    expect(tools).toHaveProperty('glob')
    expect(tools).toHaveProperty('mkdir')
    expect(tools).toHaveProperty('execute')
  })

  it('should support prefix and filter options', () => {
    const prefixed = toVercelTools(vfs, { prefix: 'vfs_' })
    expect(Object.keys(prefixed).every(k => k.startsWith('vfs_'))).toBe(true)
    expect(Object.keys(prefixed)[0]).toBe('vfs_read_file')

    const filtered = toVercelTools(vfs, { filter: name => name !== 'execute' })
    expect(Object.keys(filtered)).toHaveLength(8)
    expect(Object.keys(filtered)).not.toContain('execute')

    const combined = toVercelTools(vfs, { prefix: 'fs_', filter: name => name === 'read_file' })
    expect(Object.keys(combined)).toHaveLength(1)
    expect(combined).toHaveProperty('fs_read_file')
  })

  it('should return array when outputFormat is array', () => {
    const tools = toVercelTools(vfs, { outputFormat: 'array' })
    expect(tools).toHaveLength(9)
    expect(tools[0]).toHaveProperty('execute')
  })

  it('should execute adapted read_file tool', async () => {
    await vfs.write_file('/test.txt', 'hello vercel')
    const tools = toVercelTools(vfs, { filter: n => n === 'read_file' })
    const result = await tools.read_file.execute({ path: '/test.txt' })
    expect(result).toBe('hello vercel')
  })

  it('should execute adapted write_file tool', async () => {
    const tools = toVercelTools(vfs, { filter: n => n === 'write_file' })
    const result = await tools.write_file.execute({ path: '/new.txt', content: 'written' })
    expect(result).toContain('Wrote')
    expect(result).toContain('/new.txt')
  })

  it('should propagate errors from toolkit', async () => {
    const tools = toVercelTools(vfs, { filter: n => n === 'read_file' })
    await expect(
      tools.read_file.execute({ path: '/noexist' }),
    ).rejects.toThrow('read_file failed: NOT_FOUND')
  })

  it('should expose description and parameters metadata in both output formats', () => {
    const readFile = toVercelTools(vfs, { filter: n => n === 'read_file' }).read_file
    expect(readFile).toHaveProperty('description')
    expect(typeof readFile.description).toBe('string')
    expect(readFile.description.length).toBeGreaterThan(0)
    expect(readFile).toHaveProperty('parameters')
    expect(readFile.parameters).toBeDefined()

    const arrayTools = toVercelTools(vfs, { outputFormat: 'array' })
    expect(arrayTools).toHaveLength(9)
    for (const t of arrayTools) {
      expect(t).toHaveProperty('description')
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t).toHaveProperty('parameters')
      expect(t.parameters).toBeDefined()
    }
  })
})
