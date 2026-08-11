import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { PATH_HINT } from '../constants'
import { formatToolError } from '../error'

export const editFileTool: VFSToolDefinition = {
  name: 'edit_file',
  description: `Replace a unique text occurrence in a file — use for targeted edits instead of rewriting the whole file.
- ${PATH_HINT}
- oldText must match exactly once; include surrounding context to keep it unique.
- Returns bytes written.`,
  schema: z.object({
    path: z.string().describe('File to edit.'),
    oldText: z.string().describe('Text to replace (must occur exactly once).'),
    newText: z.string().describe('Replacement text.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.edit_file(input.path, input.oldText, input.newText)
    if (!result.ok) {
      throw formatToolError('edit_file', result)
    }
    return `Replaced 1 occurrence in ${input.path} (${result.data.bytesWritten} bytes written)`
  },
}
