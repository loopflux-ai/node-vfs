import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../../packages/node-vfs/src/backend/memory'
import { createVFS } from '../../packages/node-vfs/src/index'
import { VFSToolkit } from '../../packages/toolkit/src/toolkit'
import { readFileTool } from '../../packages/toolkit/src/tools/readFile'

describe('readFileTool', () => {
  let toolkit: VFSToolkit

  beforeEach(async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    await vfs.write_file('/test.txt', 'hello world')
    toolkit = new VFSToolkit(vfs)
  })

  it('should read file content', async () => {
    const result = await toolkit.executeTool(readFileTool, { path: '/test.txt' })
    expect(result).toBe('hello world')
  })

  it('should support range read', async () => {
    const result = await toolkit.executeTool(readFileTool, {
      path: '/test.txt',
      range: { start: 0, end: 5 },
    })
    expect(result).toBe('hello')
  })

  it('should throw on missing file', async () => {
    await expect(
      toolkit.executeTool(readFileTool, { path: '/missing.txt' }),
    ).rejects.toThrow('read_file failed: NOT_FOUND')
  })

  it('should include VFS suggestions in the error message', async () => {
    await expect(
      toolkit.executeTool(readFileTool, { path: '/missing.txt' }),
    ).rejects.toThrow('Suggestions:\n- Run ls /')
  })

  it('should throw on directory path', async () => {
    await expect(
      toolkit.executeTool(readFileTool, { path: '/' }),
    ).rejects.toThrow('read_file failed: IS_DIRECTORY')
  })

  it('should truncate large output', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    const longContent = 'x'.repeat(60_000)
    await vfs.write_file('/big.txt', longContent)
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(readFileTool, { path: '/big.txt' })
    expect(result.length).toBeLessThanOrEqual(50_000 + 120)
    expect(result).toContain('[Truncated')
  })

  it('should support base64 encoding', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend() })
    const binary = new Uint8Array([0, 1, 2, 255])
    await vfs.write_file('/bin.bin', binary)
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(readFileTool, { path: '/bin.bin', encoding: 'base64' })
    expect(result).toBe('AAEC/w==')
  })

  it('should read correctly with cache disabled', async () => {
    const vfs = createVFS({ backend: new InMemoryBackend(), cache: false })
    await vfs.write_file('/nocache.txt', 'uncached content')
    const tk = new VFSToolkit(vfs)
    const result = await tk.executeTool(readFileTool, { path: '/nocache.txt' })
    expect(result).toBe('uncached content')
  })

  it('should format stream errors when cache is disabled', async () => {
    // When cache: false, read_file returns a lazy stream — backend errors
    // (EIO, mid-read ENOENT, …) surface as throws during toolkit iteration,
    // not as ErrResults at the call site. formatStreamError wraps them.
    const backend = new InMemoryBackend()
    await backend.write('/boom.txt', new TextEncoder().encode('content'), 'overwrite')
    const throwingStream: AsyncIterable<Uint8Array> = {
      async* [Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2, 3])
        throw Object.assign(new Error('disk read error'), { code: 'EIO' })
      },
    }
    backend.read = () => throwingStream
    const vfs = createVFS({ backend, cache: false })
    const tk = new VFSToolkit(vfs)
    await expect(
      tk.executeTool(readFileTool, { path: '/boom.txt' }),
    ).rejects.toThrow('read_file failed: EIO')
  })
})
