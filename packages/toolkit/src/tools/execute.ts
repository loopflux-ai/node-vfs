import type { VFSToolDefinition } from '../types'
import { z } from 'zod'
import { DEFAULT_MAX_OUTPUT_CHARS, ENV_HINT, PATH_HINT, TRUNCATION_MARKER, truncationNote } from '../constants'
import { formatToolError } from '../error'
import { buildEnvironmentPrompt, getSystemContext } from '../system'

const BASE_DESCRIPTION = `Run a command on the host. Use only when the file tools cannot do the job (scripts, builds, system queries).

MUST:
- SPLIT THE INVOCATION: "command" is the command/action name only — an executable like "node"/"git", or a Windows builtin like "dir"/"start"; ALL arguments go into "args".
  ✓ { "command": "node", "args": ["-e", "console.log(1)"] }
  ✓ { "command": "dir", "args": ["C:\\\\Users\\\\you"] }
  ✗ { "command": "node -e console.log(1)" }
- The VFS picks the executor: resolvable executables spawn directly (no shell); Windows builtins with no standalone executable (dir/start/del/...) are dispatched through cmd automatically. NEVER write "cmd" or "cmd /c" yourself.
- ARGUMENTS ARE PLAIN VALUES: they must not contain cmd shell metacharacters (& | < > ^) — builtin dispatch goes through cmd, where those would be interpreted as chaining/redirection. Pipes, redirection and command chaining are not supported; rework such needs with the file tools (read_file / write_file / edit_file / delete_file / mkdir).
- STARTING A GUI APP (Windows): { "command": "start", "args": ["", "C:\\\\path\\\\to\\\\app.exe"] } — the first empty arg is the cmd window-title placeholder and must stay. "start" produces no output and does not wait for the app; after starting, verify the process with { "command": "tasklist", "args": ["/FI", "IMAGENAME eq app.exe"] } before reporting success.
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
- FILE OPERATIONS GO THROUGH THE FILE TOOLS: read_file / write_file / edit_file / delete_file enforce the policy deny-list; execute's file builtins (type / del / copy / move) do NOT. Prefer the file tools so policy-protected paths stay protected.
- If writing files, declare them in "affectedPaths".`

const EXECUTE_SCHEMA = z.object({
  command: z.string().describe('Command/action name only — an executable name (e.g. "node", "git") or a Windows builtin (e.g. "dir", "start"). Do NOT put arguments here — put them in "args".'),
  args: z.array(z.string()).optional().describe('Arguments, one per array element (e.g. ["-e", "console.log(1)"]). Plain values only — no cmd shell metacharacters (& | < > ^).'),
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
