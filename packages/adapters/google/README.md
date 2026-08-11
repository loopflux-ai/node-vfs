# @loopflux/node-vfs-google

Google ADK adapter for [`@loopflux/node-vfs-toolkit`](../../toolkit/README.md). Converts VFS tools into ADK `FunctionTool`s.

## Install

```bash
pnpm add @loopflux/node-vfs-google @loopflux/node-vfs-toolkit @loopflux/node-vfs
```

Peer dependencies: `@google/adk >= 1.5.0`, `zod 4.4.3`.

## Quick Start

```ts
import { Agent } from '@google/adk'
import { createVFS, FilesystemBackend } from '@loopflux/node-vfs'
import { toGoogleTools } from '@loopflux/node-vfs-google'

const vfs = createVFS({
  backend: new FilesystemBackend({ rootDir: './sandbox', virtualMode: true }),
  execute: { allowCommands: ['node'] }, // required to enable the execute tool
})

const agent = new Agent({
  name: 'fs_agent',
  model,
  tools: toGoogleTools(vfs),
})

// Run the agent with your ADK runtime; the VFS tools are available for
// file operations and (if allow-listed) command execution.
```

## Options

```ts
interface GoogleAdapterOptions {
  prefix?: string // e.g. 'vfs_' → vfs_read_file
  filter?: (toolName: string) => boolean // include only matching tools
}
```

```ts
toGoogleTools(vfs, { prefix: 'vfs_', filter: n => n !== 'execute' })
```

## Return Type

Returns `FunctionTool[]` — ready for the ADK `Agent({ tools })` constructor.

## Security

The `execute` tool only works if `createVFS({ execute: { allowCommands: [...] } })` explicitly provides an allow-list — otherwise it returns `PERMISSION_DENIED` with an actionable message. File operations go through the VFS tools, never through shell commands.
