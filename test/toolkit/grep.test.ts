import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { grepTool } from '../../packages/toolkit/src/tools/grep'

describe('grepTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/f.txt', 'hello\nworld\nhello again')
    await vfs.write_file('/other.txt', 'no match here')
    toolkit = new VFSToolkit(vfs)
  })

  it('should find matching lines', async () => {
    const result = await toolkit.executeTool(grepTool, { path: '/', pattern: 'hello' })
    expect(result).toContain('Found 2 matches')
    expect(result).toContain('/f.txt:1: hello')
    expect(result).toContain('/f.txt:3: hello again')
  })

  it('should return no matches message', async () => {
    const result = await toolkit.executeTool(grepTool, { path: '/', pattern: 'zzz' })
    expect(result).toContain('No matches found')
  })

  it('should throw on empty pattern', async () => {
    await expect(
      toolkit.executeTool(grepTool, { path: '/', pattern: '' }),
    ).rejects.toThrow('grep failed: INVALID_PATTERN')
  })

  it('should respect maxResults', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/lines.txt', 'line1\nline2\nline3\nline4\nline5')
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(grepTool, {
      path: '/',
      pattern: 'line',
      maxResults: 2,
    })
    expect(result).toContain('Found 2 matches')
  })

  it('should support case-insensitive flag', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/case.txt', 'HELLO world')
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(grepTool, {
      path: '/',
      pattern: 'hello',
      flags: 'i',
    })
    expect(result).toContain('Found 1 matches')
    expect(result).toContain('HELLO')
  })

  it('should support multiline flag', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/ml.txt', 'foo\nbar\nfoo')
    const tk = new VFSToolkit(vfs)
    // ^foo matches "foo" only at line start
    const result = await tk.executeTool(grepTool, {
      path: '/',
      pattern: '^foo',
      flags: 'm',
    })
    expect(result).toContain('Found 2 matches')
  })

  it('should truncate large output', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    // Generate a file with many lines to exceed DEFAULT_MAX_OUTPUT_CHARS
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i}: ${'x'.repeat(200)}`)
    await vfs.write_file('/big.txt', lines.join('\n'))
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(grepTool, { path: '/', pattern: 'line' })
    expect(result).toContain('[Truncated')
  })
})
