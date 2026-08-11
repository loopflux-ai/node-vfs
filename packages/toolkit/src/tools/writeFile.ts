import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { PATH_HINT } from '../constants'
import { formatToolError } from '../error'

export const writeFileTool: VFSToolDefinition = {
  name: 'write_file',
  description: `Write text to a file. Use for creating or replacing file content.
- ${PATH_HINT}
- mode: overwrite (default) replaces all content | create fails if the file exists | append adds to the end.
- Returns bytes written.`,
  schema: z.object({
    path: z.string().describe('File to write.'),
    content: z.string().describe('Content to write (UTF-8).'),
    mode: z.enum(['overwrite', 'create', 'append']).default('overwrite').describe('overwrite | create | append.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.write_file(input.path, input.content, {
      mode: input.mode,
    })
    if (!result.ok) {
      throw formatToolError('write_file', result)
    }
    return `Wrote ${result.data.bytesWritten} bytes to ${input.path} (${result.data.mode})`
  },
}
