import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, PATH_HINT, TRUNCATION_MARKER, truncationNote } from '../constants'
import { formatToolError } from '../error'

export const grepTool: VFSToolDefinition = {
  name: 'grep',
  description: `Search file contents for text or regex. Use to find where something appears across files.
- ${PATH_HINT} — file or directory (directories are searched recursively).
- No 'flags': case-insensitive plain substring. With 'flags' (i, m, g): RegExp.
- Results capped at 'maxResults' (default 100).
- Returns matching lines with their file path and line number.`,
  schema: z.object({
    path: z.string().describe('File or directory to search.'),
    pattern: z.string().describe('Text or regex pattern to find.'),
    flags: z.string().optional().describe('RegExp flags: i, m, g. Omit for plain text.'),
    maxResults: z.number().int().positive().default(100).describe('Max matches (default 100).'),
  }),
  async execute(input, ctx) {
    const result = await ctx.vfs.grep(input.path, input.pattern, {
      flags: input.flags,
      maxResults: input.maxResults,
    })
    if (!result.ok) {
      throw formatToolError('grep', result)
    }

    const matches: string[] = []
    for await (const match of result.data) {
      matches.push(`${match.path}:${match.lineNumber}: ${match.text}`)
    }

    let output = matches.length === 0
      ? `No matches found for pattern "${input.pattern}"`
      : `Found ${matches.length} matches:\n${matches.join('\n')}`

    if (result.meta.truncated) {
      // Report the real reason (4 MiB read cap or maxResults), and keep the
      // note even when there are no matches so the LLM does not conclude the
      // file was fully searched.
      const reason = result.meta.truncateReason === 'fileSize' ? 'maxFileSize' : 'maxResults'
      output = output.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + truncationNote(reason)
    }
    else if (output.length > DEFAULT_MAX_OUTPUT_CHARS) {
      output = output.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
    }

    return output
  },
}
