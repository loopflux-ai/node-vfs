import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { PATH_HINT } from '../constants'
import { formatToolError } from '../error'

export const deleteFileTool: VFSToolDefinition = {
  name: 'delete_file',
  description: `Delete a file; delete a directory with recursive: true.
- ${PATH_HINT}
- Returns a confirmation message with the deleted path.
- Permanent — use with care.`,
  schema: z.object({
    path: z.string().describe('File or directory to delete.'),
    recursive: z.boolean().default(false).describe('true deletes directories and their contents.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.delete_file(input.path, { recursive: input.recursive })
    if (!result.ok) {
      throw formatToolError('delete_file', result)
    }
    const isDir = result.meta?.wasDirectory ?? false
    const type = isDir ? 'directory' : 'file'
    return `Deleted ${type}: ${input.path}`
  },
}
