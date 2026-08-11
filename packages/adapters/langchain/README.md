# @loopflux/node-vfs-langchain

LangChain adapter for [`@loopflux/node-vfs-toolkit`](../../toolkit/README.md). Converts VFS tools into LangChain `Tool`s.

## Install

```bash
pnpm add @loopflux/node-vfs-langchain @loopflux/node-vfs-toolkit @loopflux/node-vfs
```

Peer dependencies: `@langchain/core >= 1.2.1`, `zod >= 4.4.3`.

## Quick Start

```ts
import { createVFS, FilesystemBackend } from '@loopflux/node-vfs'
import { toLangChainTools } from '@loopflux/node-vfs-langchain'
import { createAgent } from 'langchain'

const vfs = createVFS({
  backend: new FilesystemBackend({ rootDir: './sandbox', virtualMode: true }),
  execute: ['node'], // required to enable the execute tool
})

const agent = createAgent({
  model,
  tools: toLangChainTools(vfs),
})

const res = await agent.invoke({
  messages: [{ role: 'user', content: 'List the files in the sandbox.' }],
})
```

## Options

```ts
interface LangChainAdapterOptions {
  prefix?: string // e.g. 'vfs_' → vfs_read_file
  filter?: (toolName: string) => boolean // include only matching tools
}
```

```ts
toLangChainTools(vfs, { prefix: 'vfs_', filter: n => n !== 'execute' })
```

## Return Type

Returns `Tool[]` — ready for `createAgent({ tools })`, `bindTools()`, or any LangChain tool collection.

While a tool runs, it emits a status update (`[vfs] executing <name>...`) through the runtime writer when one is available.

## Security

The `execute` tool only works if `createVFS({ execute: [...] })` explicitly provides an allow-list — otherwise it returns `PERMISSION_DENIED` with an actionable message. File operations go through the VFS tools, never through shell commands.
