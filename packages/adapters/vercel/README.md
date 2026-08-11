# @loopflux/node-vfs-vercel

Vercel AI SDK adapter for [`@loopflux/node-vfs-toolkit`](../../toolkit/README.md). Converts VFS tools into AI SDK `Tool`s.

## Install

```bash
pnpm add @loopflux/node-vfs-vercel @loopflux/node-vfs-toolkit @loopflux/node-vfs
```

Peer dependencies: `ai >= 7.0.0`, `zod >= 4.4.3`.

## Quick Start

```ts
import { createVFS, FilesystemBackend } from '@loopflux/node-vfs'
import { toVercelTools } from '@loopflux/node-vfs-vercel'
import { generateText } from 'ai'

const vfs = createVFS({
  backend: new FilesystemBackend({ rootDir: './sandbox', virtualMode: true }),
  execute: ['node'], // required to enable the execute tool
})

const tools = toVercelTools(vfs)

const { text } = await generateText({
  model,
  tools,
  prompt: 'List the files in the sandbox.',
})
```

## Options

```ts
interface VercelAdapterOptions {
  prefix?: string // e.g. 'vfs_' → vfs_read_file
  filter?: (toolName: string) => boolean // include only matching tools
  outputFormat?: 'object' | 'array' // default 'object'
}
```

- `'object'` (default): `Record<string, VercelTool>` — drop-in for `generateText({ tools })`.
- `'array'`: `VercelTool[]` — convenient for iteration or merging with other tools.

```ts
toVercelTools(vfs, { prefix: 'vfs_', filter: n => n !== 'execute' })
```

## Return Type

```ts
interface VercelTool {
  description: string
  parameters: z.ZodSchema
  execute: (input: Record<string, unknown>) => Promise<string>
}
```

A wrapper exposing `description` / `parameters` / `execute`, abstracting `ai.Tool` internals.

## Security

The `execute` tool only works if `createVFS({ execute: [...] })` explicitly provides an allow-list — otherwise it returns `PERMISSION_DENIED` with an actionable message. File operations go through the VFS tools, never through shell commands.
