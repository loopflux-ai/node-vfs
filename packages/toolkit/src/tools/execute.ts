import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, ENV_HINT, PATH_HINT, TRUNCATION_MARKER, truncationNote } from '../constants'
import { formatToolError } from '../error'
import { buildEnvironmentPrompt, getSystemContext } from '../system'

const BASE_DESCRIPTION = `Run a command on the host. Use only when the file tools cannot do the job (scripts, builds, system queries).

MUST:
- SPLIT THE INVOCATION: "command" is the executable name only; ALL arguments go into "args". The VFS spawns directly (no shell) — a full command line fails.
  ✓ { "command": "node", "args": ["-e", "console.log(1)"] }
  ✗ { "command": "node -e console.log(1)" }
- ENCODING: modern tools (node, git) emit UTF-8; Windows legacy tools (cmd, powershell) emit ANSI (e.g. GBK on zh-CN) — decoded automatically (UTF-8 first). If still garbled, use node (if allowed) or set "outputEncoding".
- ${PATH_HINT}
- ${ENV_HINT}
- "cwd" defaults to "/" (sandbox root); relative cwd resolves under rootDir.

Output:
- Returns stdout (truncated over ~50k chars). Non-zero exit appends "[Command exited with code N]" and any stderr. On Windows, exit 1 with no output usually means the executable was not found — check stderr.
- Empty output is reported explicitly — don't assume success.

Safety:
- Destructive — use with care.
- Default-deny: unlisted commands are rejected — rework the command or report the failure, don't retry.
- If writing files, declare them in "affectedPaths".`

const EXECUTE_SCHEMA = z.object({
  command: z.string().describe('Executable name only (e.g. "node", "git", "powershell"). Do NOT put arguments here — put them in "args".'),
  args: z.array(z.string()).optional().describe('Arguments passed to the executable, one per array element (e.g. ["-c", "console.log(1)"] or ["/c", "dir"]).'),
  cwd: z.string().default('/').describe('Working directory — "/" is the sandbox root; relative paths resolve under rootDir.'),
  env: z.record(z.string(), z.string()).optional().describe('Extra env vars merged over the inherited host env (the VFS may strip configured blocklisted vars — exact names or patterns).'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds.'),
  maxOutputBytes: z.number().int().positive().optional().describe('Max output bytes to capture.'),
  outputEncoding: z.string().optional().describe('Rarely needed — omit it. Explicit TextDecoder label (e.g. "gbk") when output is garbled; otherwise decoding tries UTF-8 first, then the system ANSI code page.'),
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
      // Runtime guard — "command" must be an executable name, not a full
      // command line. This is the single choke point across all adapters:
      // schema-level constraints are stripped during JSON-schema
      // serialization and would be invisible to the LLM.
      if (/\s/.test(input.command) && !/^"[^"]+"$/.test(input.command.trim())) {
        throw new Error(
          'execute failed: "command" must be the executable name only (e.g. "node"), '
          + 'not a full command line. Move all arguments to "args" '
          + '(e.g. { command: "node", args: ["script.js"] }).',
        )
      }
      const result = await ctx.vfs.execute(input.command, {
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        outputEncoding: input.outputEncoding,
        scope: input.scope,
        affectedPaths: input.affectedPaths,
      })
      if (!result.ok) {
        throw formatToolError('execute', result)
      }

      let stdout = result.data.stdout
      if (typeof stdout !== 'string') {
        // Defensive only — backends are expected to return decoded strings.
        // Encoding detection is the backend's responsibility (it knows the
        // byte source's code page); do not duplicate it here.
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
      else if (result.data.stderr) {
        // exit 0 but produced diagnostics on stderr — don't silently drop them.
        output += `\nStderr: ${result.data.stderr}`
      }

      if (!output.trim()) {
        output = '[Command produced no output — the executable may not exist, or "command" was not an executable name. Use "command" for the program and "args" for its arguments.]'
      }

      return output
    },
  }
}

/** Static execute tool without environment announcement (backwards compatible). */
export const executeTool = createExecuteTool()
