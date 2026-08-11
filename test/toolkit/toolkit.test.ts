import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { getSystemContext } from '../../packages/toolkit/src/system'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { ALL_TOOLS, readFileTool } from '../../packages/toolkit/src/tools/index'

describe('vFSToolkit', () => {
  let toolkit: VFSToolkit

  beforeEach(() => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    toolkit = new VFSToolkit(vfs)
  })

  it('should return all 9 tools', () => {
    const tools = toolkit.getTools()
    expect(tools.length).toBe(9)
    const names = tools.map(t => t.name)
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'delete_file',
      'mkdir',
      'grep',
      'ls',
      'glob',
      'execute',
    ])
  })

  it('should find tool by name', () => {
    const tool = toolkit.getTool('read_file')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('read_file')
  })

  it('should return undefined for unknown tool', () => {
    const tool = toolkit.getTool('unknown_tool')
    expect(tool).toBeUndefined()
  })

  it('should merge dynamic context', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/f.txt', 'test')
    const tk = new VFSToolkit(vfs, { cwd: '/default' })
    const result = await tk.executeTool(readFileTool, { path: '/f.txt' })
    expect(result).toBe('test')
  })

  it('should expose ALL_TOOLS as read-only array', () => {
    expect(ALL_TOOLS.length).toBe(9)
    expect(ALL_TOOLS[0]!.name).toBe('read_file')
  })

  it('should create a directory via the mkdir tool', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    const tk = new VFSToolkit(vfs)
    const mkdir = tk.getTool('mkdir')!
    const out = await tk.executeTool(mkdir, { path: '/sub' })
    expect(out).toBe('Created directory: /sub')

    const again = await tk.executeTool(mkdir, { path: '/sub' })
    expect(again).toBe('Already exists: /sub')
  })

  it('should announce the host platform in the execute tool description', () => {
    const tools = toolkit.getTools()
    const execute = tools.find(t => t.name === 'execute')!
    expect(execute.description).toContain('**Environment**')
    expect(execute.description).toContain(`Host: ${getSystemContext().platformLabel}`)
  })

  it('should announce the host platform in ALL_TOOLS execute tool', () => {
    const execute = ALL_TOOLS.find(t => t.name === 'execute')!
    expect(execute.description).toContain('**Environment**')
    expect(execute.description).toContain(`Host: ${getSystemContext().platformLabel}`)
  })

  it('should override default cwd with dynamic context', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/f.txt', 'test')
    const tk = new VFSToolkit(vfs, { cwd: '/default' })
    // Dynamic context overrides default.
    const result = await tk.executeTool(readFileTool, { path: '/f.txt' }, { cwd: '/override' })
    expect(result).toBe('test')
  })
})
