import type { VFSToolDefinition } from '../types'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, PATH_HINT, TRUNCATION_MARKER } from '../constants'
import { formatStreamError, formatToolError } from '../error'

export const readFileTool: VFSToolDefinition = {
  name: 'read_file',
  description: `Read a file's contents. Use for inspecting code, config, or data files.
- ${PATH_HINT}
- 'range' reads a byte slice [start, end) — use it for large files.
- encoding: utf8 (default) | base64 | hex — use base64/hex for binary files.
- Returns the file content as text (utf8) or encoded string (base64/hex).
- Fails if the path is a directory or does not exist.`,
  schema: z.object({
    path: z.string().describe('File to read.'),
    range: z.object({
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
    }).optional().describe('Byte range [start, end).'),
    encoding: z.enum(['utf8', 'base64', 'hex']).default('utf8').describe('utf8 | base64 | hex.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.read_file(input.path, {
      range: input.range,
      encoding: input.encoding,
    })
    if (!result.ok) {
      throw formatToolError('read_file', result)
    }

    const chunks: Uint8Array[] = []
    try {
      for await (const chunk of result.data) {
        chunks.push(chunk)
      }
    }
    catch (e) {
      throw formatStreamError('read_file', e)
    }
    const full = Buffer.concat(chunks)
    let content = input.encoding === 'utf8'
      ? full.toString('utf8')
      : full.toString(input.encoding)

    if (content.length > DEFAULT_MAX_OUTPUT_CHARS) {
      content = content.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
    }

    return content
  },
}
