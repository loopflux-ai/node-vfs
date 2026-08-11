import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, PATH_HINT, TRUNCATION_MARKER } from '../constants'
import { formatToolError } from '../error'

export const lsTool: VFSToolDefinition = {
  name: 'ls',
  description: `List a directory's entries. Use to explore a directory's contents.
- ${PATH_HINT}
- Returns type, name, size, and date for each entry.
- Paginate with 'cursor' + 'limit'.`,
  schema: z.object({
    path: z.string().describe('Directory to list.'),
    limit: z.number().int().positive().default(100).describe('Max entries (default 100).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous ls.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.ls(input.path, { limit: input.limit, cursor: input.cursor })
    if (!result.ok) {
      throw formatToolError('ls', result)
    }

    const entries = result.data.entries
    if (entries.length === 0) {
      return `Directory ${input.path} is empty.`
    }

    let output = `Entries in ${input.path}:\n`
    output += entries.map(e =>
      `${e.isDirectory ? 'DIR' : '   '} ${e.name} (${e.size} bytes, ${new Date(e.mtimeMs).toISOString().slice(0, 10)})`,
    ).join('\n')

    if (result.data.nextCursor) {
      output += `\n\n... (more entries exist, use cursor: "${result.data.nextCursor}" to get next page)`
    }

    if (output.length > DEFAULT_MAX_OUTPUT_CHARS) {
      output = output.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
    }

    return output
  },
}
