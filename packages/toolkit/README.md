# @loopflux/node-vfs-toolkit

LLM tool layer for [`@loopflux/node-vfs`](../node-vfs/README.md). Wraps the VFS engine into tool definitions (zod schemas + LLM-facing descriptions) for function-calling agents.

## Install

```bash
pnpm add @loopflux/node-vfs-toolkit @loopflux/node-vfs
```

Peer dependencies: `zod >= 4.4.3`, `@loopflux/node-vfs >= 0.0.1`.

## Quick Start

```ts
import { createVFS, InMemoryBackend } from '@loopflux/node-vfs'
import { VFSToolkit } from '@loopflux/node-vfs-toolkit'

const vfs = createVFS({ backend: new InMemoryBackend() })
const toolkit = new VFSToolkit(vfs)

const tools = toolkit.getTools() // 9 VFSToolDefinitions, read-only

// Drive a tool directly:
const output = await toolkit.executeTool(tools[0]!, {
  path: '/hello.txt',
})
```

`VFSToolDefinition`:

```ts
interface VFSToolDefinition {
  name: string
  description: string // LLM-facing; includes path semantics
  schema: z.ZodSchema // validated input
  execute: (input, ctx) => Promise<string> // ctx: { vfs, cwd? }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `read_file` | Read a file (utf8/base64/hex, optional byte range) |
| `write_file` | Create or replace content (`overwrite`/`create`/`append`) |
| `edit_file` | Replace a unique text occurrence (targeted edits) |
| `delete_file` | Delete a file, or a directory with `recursive: true` |
| `mkdir` | Create directories, like `mkdir -p` |
| `grep` | Search file contents (plain substring or regex via `flags`) |
| `ls` | List a directory's entries (paginated) |
| `glob` | Find files by glob pattern (paginated) |
| `execute` | Run a host command (respects the VFS allow-list) |

All tools are exported individually (e.g. `readFileTool`) and collected in `ALL_TOOLS`.

## Key Mechanisms

### Dynamic path hints

Tool descriptions are generated from the backend's sandbox metadata. When the backend exposes `rootDir` + `virtualMode`, the description provides the exact root mapping so the LLM can translate host paths to virtual paths deterministically:

```ts
const toolkit = new VFSToolkit(vfs) // → read_file description now includes:
// "Sandbox root "/" maps to "/abs/path/to/sandbox". Host absolute paths are rejected."
```

### Error formatting

VFS errors are converted into actionable `Error`s, appending `suggestions`:

```ts
import { formatToolError } from '@loopflux/node-vfs-toolkit'

// read_file failed: NOT_FOUND — Path not found: /missing.txt
// Suggestions:
// - Run ls / to see available entries
// - Verify the exact name and case (filesystems may be case-sensitive)
```

`formatStreamError` wraps stream-iteration errors (relevant when the VFS cache is disabled and lazy reads throw during consumption).

### Output truncation

Tool output is capped at `DEFAULT_MAX_OUTPUT_CHARS` (50 000 chars, ~12 500 tokens). Truncation notes are reason-specific (`maxOutputChars` / `maxFileSize` / `maxOutputBytes` / `maxResults`) so the LLM knows why output was cut.

### Platform context

The `execute` tool announces the host environment (`Windows (win32, x64, cmd-compatible shell)` / POSIX) in its description so the agent can select commands appropriate to the host shell.

## Framework Adapters

Use the toolkit directly with any function-calling loop, or plug into a framework:

| Framework | Adapter | Docs |
|---|---|---|
| Vercel AI SDK | `@loopflux/node-vfs-vercel` | [README](../adapters/vercel/README.md) |
| LangChain | `@loopflux/node-vfs-langchain` | [README](../adapters/langchain/README.md) |
| Google ADK | `@loopflux/node-vfs-google` | [README](../adapters/google/README.md) |
