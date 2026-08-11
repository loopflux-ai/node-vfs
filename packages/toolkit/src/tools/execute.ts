import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, TRUNCATION_MARKER, truncationNote } from '../constants'
import { formatToolError } from '../error'
import { buildEnvironmentPrompt, getSystemContext } from '../system'

const BASE_DESCRIPTION = `Run a command on the host. Use only for operations the file tools cannot do (e.g. running scripts or builds).
- cwd defaults to "/" (the sandbox root); relative cwd is resolved under rootDir; host absolute cwd (e.g. "C:/...") may be rejected depending on backend configuration.
- stdout is returned; on non-zero exit, the exit code and stderr are appended.
- env vars are passed through (dangerous ones filtered).
- Destructive — use with care.
- NOTE: execute restrictions (deny/allow lists) are deployment policy — this tool reports them via errors. File operations should still go through the VFS file tools (read_file / write_file / edit_file / delete_file / mkdir).
- If you intend to modify files, declare the affected virtual paths via "affectedPaths" so the VFS policy can validate them.`

const EXECUTE_SCHEMA = z.object({
  command: z.string().describe('Command to run (e.g., "node script.js").'),
  args: z.array(z.string()).optional().describe('Command arguments.'),
  cwd: z.string().default('/').describe('Working directory (default "/" = sandbox root).'),
  env: z.record(z.string(), z.string()).optional().describe('Extra env vars (dangerous ones filtered).'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds.'),
  maxOutputBytes: z.number().int().positive().optional().describe('Max output bytes to capture.'),
  scope: z.enum(['readonly', 'readwrite']).optional().describe('Declared access scope: "readonly" (default, no write intent) or "readwrite" (may modify files).'),
  affectedPaths: z.array(z.string()).optional().describe('Virtual paths this command may modify. Validated against the VFS policy — declare them honestly when writing files.'),
})

export function createExecuteTool(): VFSToolDefinition {
  const ctx = getSystemContext()
  const description = `${BASE_DESCRIPTION}\n**Environment**: ${buildEnvironmentPrompt(ctx)}`
  return {
    name: 'execute',
    description,
    schema: EXECUTE_SCHEMA,
    async execute(input, ctx) {
      const result = await ctx.vfs.execute(input.command, {
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        scope: input.scope,
        affectedPaths: input.affectedPaths,
      })
      if (!result.ok) {
        throw formatToolError('execute', result)
      }

      let stdout = result.data.stdout
      if (typeof stdout !== 'string') {
        stdout = new TextDecoder().decode(stdout)
      }

      let output = stdout
      if (result.data.truncated) {
        output = output.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + truncationNote('maxOutputBytes')
      }
      else if (output.length > DEFAULT_MAX_OUTPUT_CHARS) {
        output = output.slice(0, DEFAULT_MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
      }

      if (result.data.exitCode !== 0) {
        output += result.data.wasKilled
          ? '\n\n[Command was cancelled]'
          : `\n\n[Command exited with code ${result.data.exitCode}]`
        if (result.data.stderr) {
          output += `\nStderr: ${result.data.stderr}`
        }
      }

      return output
    },
  }
}

/** Static execute tool without environment announcement (backwards compatible). */
export const executeTool = createExecuteTool()
