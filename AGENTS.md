# AGENTS.md

Working guide for AI coding agents. Read this before modifying the repository.

## Project Overview

`node-vfs` is a virtual file system (VFS) for LLM agents. pnpm monorepo, pure ESM, TypeScript.

```txt
packages/
  node-vfs/   @loopflux/node-vfs          Core engine
  toolkit/    @loopflux/node-vfs-toolkit  LLM tool layer (zod schemas + LLM-facing descriptions)
  adapters/   Grouping directory containing 3 standalone packages
    vercel/   @loopflux/node-vfs-vercel     AI SDK adapter
    langchain/ @loopflux/node-vfs-langchain LangChain adapter
    google/   @loopflux/node-vfs-google     Google ADK adapter
test/          Vitest tests (22 files, 53 describe blocks)
```

Dependency direction: `adapters → toolkit → node-vfs`, all `workspace:*`. Use pnpm everywhere — do not mix npm/yarn.

## Common Commands

```bash
pnpm build               # Build all packages (tsdown)
pnpm typecheck           # Type-check the whole monorepo
pnpm lint                # ESLint (antfu config)
pnpm test                # Run all tests (vitest run)
pnpm --filter @loopflux/node-vfs build        # Build a single package
pnpm --filter @loopflux/node-vfs typecheck    # Type-check a single package
pnpm test -- vfs.test.ts                      # Run a single test file
pnpm test -- vfs.test.ts -t "read_file"       # Filter by test name
```

## Architecture Conventions

### node-vfs layering (`packages/node-vfs/src/`)

```txt
vfs.ts        createVFS facade: validatePath → user middleware (compose) → built-in cache → dispatch → backend
types.ts      Result discriminated union + OpRegistry (kind → {op, data, meta} strongly-typed mapping)
errors.ts     ERR.* error registry + err() freezing into ErrResult
path.ts       validatePath path validation, ancestorPaths, cursor encode/decode
cache.ts      Built-in cache subsystem (LRU + reverse index, CQRS)
backend/      StorageBackend interface + FilesystemBackend / InMemoryBackend implementations
handlers/     9 pure handlers + dispatch table + kinds.ts (isQueryOp/isCommandOp)
middleware/   compose (onion) + logging / policy / quota
utils/        tokens, mutex, batch (p-limit), signal, env (child env builder), debug
```

### toolkit (`packages/toolkit/src/tools/`)

Each tool is a `VFSToolDefinition` (name / description / schema(zod) / execute). The description is LLM-facing and must reference `PATH_HINT` and explain path semantics. When adding a tool, sync all of:
1. `ALL_TOOLS` in `tools/index.ts`
2. The three adapter tests (`test/adapters/*.test.ts`)
3. The corresponding toolkit test (`test/toolkit/*.test.ts`)

### adapters (`packages/adapters/*/src/adapter.ts`)

Adding a new framework adapter = copy the existing pattern (`prefix` / `filter` options, wrapping `VFSToolkit`). Do not duplicate VFS logic.

## Inviolable Contracts

- **The `code` strings in `errors.ts` are a stable contract — never rename them.** LLMs rely on `code` + `suggestions` for error recovery; the backend error mapping lives in `BACKEND_CODE_MAP` in `vfs.ts`.
- **`OpRegistry` in `types.ts`**: adding an op requires syncing the dispatch table, `serialisedParams`/`entryPaths` in cache.ts, and the toolkit. `OpKind` is `keyof OpRegistry` — omissions fail at compile time.
- **The CQRS split in `kinds.ts` drives cache behavior**: query ops (read_file/grep/ls/glob) are cached; command ops (write/edit/delete/mkdir/execute) invalidate the cache on success. New ops must be classified into one of the two.
- **The `DEBUG_CATEGORY` constants in `utils/debug.ts` are the log-filtering contract surface** — callers must never hardcode the string literals.
- **execute is default-deny**: it is only usable when `createVFS({ execute: { allowCommands: [...] } })` explicitly provides an allow-list (command names or regexes).
- **The sandbox boundary must not be bypassed**: no new code may circumvent `validatePath`, policy deny, or the backend's `assertInsideRoot`/symlink-escape detection.
- **The cache is a built-in subsystem with a fixed position** (inside `vfs.ts`, outside user middleware, above the handler). Do not convert it into a user middleware — otherwise policy-denied results could enter the cache.
- **Result unpacking convention**: tests must unpack `Result` with `expectOkResult` / `expectErrResult` from `test/helpers.ts`. Never assert inside an `if (result.ok)` block (assertions there silently pass).

## Testing Requirements

- Coverage thresholds (`vitest.config.ts`): statements 85% / branches 80% / functions 85% / lines 85%.
- **Import from src, never dist**: the vitest alias only covers `@loopflux/node-vfs`. Toolkit/adapter tests must reference src directly via relative paths, e.g. `from '../../packages/toolkit/src/tools/readFile'` — do not import `@loopflux/node-vfs-toolkit` (it resolves to the dist build).
- Backend error mapping (ENOENT→NOT_FOUND, EACCES→PERMISSION_DENIED, etc.) has dedicated tests; update them when changing `BACKEND_CODE_MAP` or the handlers.
- Every error/warning message must carry LLM-actionable `suggestions` (`ErrSpec` in `errors.ts` has three parts: code / error / suggestions).

## Pitfalls

- **Streaming results**: `read_file` / `grep` return `AsyncIterable`. Cache handling for streams follows the drain → replay pattern in `cache.ts`; with `cache: false`, backend errors on `read_file` surface only while consuming the stream (the toolkit handles this via `formatStreamError`).
- **The orphan `export {}` at the top/bottom of some files is required by the antfu ESLint config — do not remove it** (present in `types.ts`, `vfs.ts`, `backend/memory.ts`, etc.).
- The example `examples/test/index.ts` embeds an API credential for demo purposes only; never copy the hardcoded-credential pattern into new code.

## Workflow

- All build artifacts (dist) are produced by `pnpm build`; never hand-edit `dist/`.
