# node-vfs

A sandboxed virtual file system for LLM agents, combining pluggable storage backends, middleware, and caching with default-deny execution and an error contract that carries codes, suggestions, and token estimates.

## Features

- **Secure by default**: path-traversal and symlink-escape detection, policy deny-lists, and **default-deny** command execution.
- **9 operations**: `read_file` · `write_file` · `edit_file` · `delete_file` · `mkdir` · `grep` · `ls` · `glob` · `execute`
- **LLM-oriented**: every result carries a token estimate; errors expose `code`, `error`, and `suggestions`; large files are read as lazy streams.
- **CQRS + built-in cache**: query ops are cached, command ops invalidate precisely.
- **3 middleware**: structured logging · policy deny (regex, with result filtering) · byte quota
- **2 backends**: `FilesystemBackend` (atomic writes, symlink guard, virtual mode) · `InMemoryBackend` (tests)
- **Streaming**: lazy file reads with byte ranges; capped/truncated outputs
- **Cancellation**: instance-wide and per-op `AbortSignal`s, AND-combined
- **Framework adapters**: Vercel AI SDK, LangChain, and Google ADK

## Architecture

```txt
┌────────────────────────────────────────────────────────┐
│  createVFS facade  (path validation, signals, errors)  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  user middleware  (logging / policy / quota)     │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  built-in cache  (CQRS, LRU + reverse idx) │  │  │
│  │  │  ┌──────────────────────────────────────┐  │  │  │
│  │  │  │  handlers  (9 ops, pure functions)   │  │  │  │
│  │  │  │  ┌────────────────────────────────┐  │  │  │  │
│  │  │  │  │  backend  (disk / memory)      │  │  │  │  │
│  │  │  │  └────────────────────────────────┘  │  │  │  │
│  │  │  └──────────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

## Quick Start

```ts
import { createVFS, FilesystemBackend } from '@loopflux/node-vfs'
import { VFSToolkit } from '@loopflux/node-vfs-toolkit'

const vfs = createVFS({
  backend: new FilesystemBackend({ rootDir: './sandbox', virtualMode: true }),
  execute: ['node', 'git'], // command execution is disabled by default
})

await vfs.write_file('/hello.txt', 'Hello, agent!')
const r = await vfs.read_file('/hello.txt')
if (r.ok) {
  for await (const chunk of r.data) process.stdout.write(chunk)
}

// Expose as LLM tools (zod schemas + LLM-facing descriptions):
const toolkit = new VFSToolkit(vfs)
const tools = toolkit.getTools() // 9 tools: read/write/edit/delete/mkdir/grep/ls/glob/execute
```

## Packages

| Package | Description | Docs |
|---|---|---|
| `@loopflux/node-vfs` | Core VFS engine: backends, handlers, middleware, cache | [README](packages/node-vfs/README.md) |
| `@loopflux/node-vfs-toolkit` | LLM tool layer: zod schemas, descriptions, error formatting | [README](packages/toolkit/README.md) |
| `@loopflux/node-vfs-vercel` | Vercel AI SDK adapter | [README](packages/adapters/vercel/README.md) |
| `@loopflux/node-vfs-langchain` | LangChain adapter | [README](packages/adapters/langchain/README.md) |
| `@loopflux/node-vfs-google` | Google ADK adapter | [README](packages/adapters/google/README.md) |

## Development

```bash
pnpm install
pnpm test        # vitest (coverage thresholds enforced)
pnpm typecheck   # tsc --noEmit per package
pnpm lint        # eslint (antfu config)
pnpm build       # tsdown build all packages
```

## Security

- Command execution is **disabled by default**; enable it with an explicit allow-list.
- Sandbox boundaries are enforced at three layers (path validation → policy → backend root assertion + symlink resolution).
- The execute allow-list restricts command *shape* only — for adversarial isolation, run the agent in a container or sandboxed user.

## License

MIT
