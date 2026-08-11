import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { PATH_HINT } from '../constants'
import { formatToolError } from '../error'

export const mkdirTool: VFSToolDefinition = {
  name: 'mkdir',
  description: `Create a directory (and any missing parents), like "mkdir -p". Use this to create folders — not shell mkdir.
- ${PATH_HINT}
- Already-existing directories are a no-op (returns wasCreated: false).
- Returns the path and whether it was newly created.`,
  schema: z.object({
    path: z.string().describe('Directory to create.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.mkdir(input.path)
    if (!result.ok) {
      throw formatToolError('mkdir', result)
    }
    return result.data.wasCreated
      ? `Created directory: ${result.data.path}`
      : `Already exists: ${result.data.path}`
  },
}
