import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, PATH_HINT, TRUNCATION_MARKER } from '../constants'
import { formatToolError } from '../error'

export const globTool: VFSToolDefinition = {
  name: 'glob',
  description: `Find files by glob pattern. Use to locate files by name pattern (e.g. all .ts files); ls lists a single directory instead.
- ${PATH_HINT}
- Pattern: "*", "?", "[...]", "**" (recursive), e.g. "**/*.ts".
- Returns matching entries with size; paginate with 'cursor' + 'limit'.`,
  schema: z.object({
    path: z.string().describe('Directory to search.'),
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts").'),
    limit: z.number().int().positive().default(100).describe('Max entries (default 100).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous glob.'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.glob(input.path, input.pattern, { limit: input.limit, cursor: input.cursor })
    if (!result.ok) {
      throw formatToolError('glob', result)
    }

    const entries = result.data.entries
    if (entries.length === 0) {
      return `No files matched pattern "${input.pattern}" in ${input.path}`
    }

    let output = `Found ${entries.length} files matching "${input.pattern}":\n`
    output += entries.map(e =>
      `${e.isDirectory ? 'DIR' : '   '} ${e.name} (${e.size} bytes)`,
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
