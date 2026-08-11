# @loopflux/node-vfs

A virtual file system (VFS) engine for LLM agents: sandboxed file operations, default-deny command execution, policy/quota middleware, and a built-in query cache, exposed through a strongly-typed API.

## Install

```bash
pnpm add @loopflux/node-vfs
```

## Quick Start

```ts
import { createVFS, FilesystemBackend } from '@loopflux/node-vfs'

const vfs = createVFS({
  backend: new FilesystemBackend({
    rootDir: './sandbox',
    virtualMode: true, // reject host absolute paths (e.g. C:/foo)
  }),
  execute: { allowCommands: ['node', 'git'] }, // enable execute with an allow-list (default: disabled)
})

await vfs.write_file('/notes.md', '# hello')

const result = await vfs.read_file('/notes.md')
if (!result.ok) {
  console.log(result.code, result.error) // e.g. NOT_FOUND + suggestions
  process.exit(1)
}
for await (const chunk of result.data) {
  process.stdout.write(chunk) // read_file returns a lazy byte stream
}

await vfs.dispose()
```

## Core Concepts

### Paths

Three path forms are accepted and normalized by `validatePath`:

| Form | Example | Resolution |
|---|---|---|
| Virtual absolute | `/foo/bar.txt` | Under `rootDir` |
| Relative | `foo/bar.txt` | Under `rootDir` |
| Host absolute | `C:/foo/bar.txt` | Real host path (bypasses `rootDir`) |

- Host paths are **rejected** when `virtualMode: true`.
- `..` segments, NUL/control characters, and backslashes in virtual paths are rejected (`PATH_TRAVERSAL` / `INVALID_PATH`).

### Result

Every operation returns a discriminated union:

```ts
type Result<T, M>
  = | { ok: true, data: T, meta: M, tokens: number }
    | { ok: false, code: string, error: string, suggestions: string[], opId: string, kind: OpKind, meta?: Record<string, unknown> }
```

- `tokens` estimates the LLM context cost of the result.
- Errors carry LLM-actionable `suggestions`.

### Query vs Command

- **Query ops** (`read_file`, `grep`, `ls`, `glob`) — cached by the built-in cache.
- **Command ops** (`write_file`, `edit_file`, `delete_file`, `mkdir`, `execute`) — invalidate the cache on success.

## API Reference

### `read_file(path, opts?)`

```ts
const r = await vfs.read_file('/big.log', { range: { start: 0, end: 1024 } })
```

- Returns a lazy `AsyncIterable<Uint8Array>`; errors during iteration surface as throws (use the cache-on path to get them as `ErrResult`s).
- `range` reads a byte slice `[start, end)`; `encoding`: `'utf8' | 'base64' | 'hex'` (default `'utf8'`).
- `meta.truncated` is set when the stream was cut short by signal abort.

### `write_file(path, content, opts?)`

```ts
await vfs.write_file('/a.txt', 'hello')
await vfs.write_file('/a.txt', '!', { mode: 'append' })
await vfs.write_file('/new.txt', 'x', { mode: 'create' }) // fails if exists
```

- `mode`: `'overwrite'` (default) | `'create'` | `'append'`.
- `encoding`: `'utf8' | 'base64' | 'hex'`; `content` may be a string or `Uint8Array`.
- `idempotencyKey` is reserved for deduplication; `bytesWritten` / `deltaBytes` are returned.

### `edit_file(path, oldText, newText, opts?)`

```ts
const r = await vfs.edit_file('/a.txt', 'hello', 'goodbye')
```

- `oldText` must match **exactly once** (`OLD_TEXT_NOT_FOUND` / `AMBIGUOUS`).
- Read-modify-write is guarded by a CAS check (`CONFLICT` on concurrent modification).
- Respects `limits.maxEditSize`.

### `delete_file(path, opts?)`

```ts
await vfs.delete_file('/dir', { recursive: true })
```

- Directories require `recursive: true`. Deleting `/` is always rejected.
- `meta.bytesFreed` / `meta.wasDirectory` are returned for accounting.

### `mkdir(path, opts?)`

```ts
const r = await vfs.mkdir('/a/b/c') // like `mkdir -p`
r.data.wasCreated // false when the directory already existed
```

### `grep(path, pattern, opts?)`

```ts
const r = await vfs.grep('/src', 'TODO', { maxResults: 100 })
for await (const m of r.data) {
  console.log(`${m.path}:${m.lineNumber}: ${m.text}`)
}
```

- No `flags`: case-insensitive **plain substring** match (ReDoS-proof).
- With `flags: 'i' | 'm' | 'g'`: RegExp. Pattern length capped at 4096.
- Searches a file or a directory (recursively). Truncation is reported via `meta.truncated` / `meta.truncateReason`.

### `ls(path, opts?)` / `glob(path, pattern, opts?)`

```ts
const page = await vfs.ls('/src', { limit: 100 })
for (const e of page.data.entries) {
  console.log(e.isDirectory ? 'DIR' : '   ', e.name, e.size)
}
const next = page.data.nextCursor // pass as `cursor` to paginate
```

- `glob` matches files by pattern (e.g. `**/*.ts`) inside a directory.
- Paginated via `cursor` / `limit` (max 1000). `nextCursor` is absent on the last page.
- Glob patterns containing `..` or backslashes are rejected.

### `execute(command, opts?)`

```ts
const r = await vfs.execute('node', {
  args: ['build.mjs'],
  cwd: '/',
  timeoutMs: 30_000,
})
console.log(r.data.stdout, r.data.exitCode, r.data.durationMs)
```

- **Default-deny**: every `execute` op is rejected unless `createVFS({ execute: { allowCommands: [...] } })` provides an allow-list of command names or `RegExp`s.
- `scope` (`'readonly' | 'readwrite'`) and `affectedPaths` are declarative audit fields, validated against policy — real enforcement is the allow-list + policy deny-list.
- `env` inherits the full host `process.env` by default. Strip host vars you don't want to leak via `execute: { envBlocklist: [...] }` — exact names (case-insensitive) or RegExp patterns; per-op `env` overrides still apply.
- An op-object overload is available: `vfs.execute({ kind: OP_KIND.EXECUTE, command, args })`.

#### Recommended `envBlocklist` (copy-paste, adjust to your deployment)

The child env is only as clean as this list — nothing is filtered implicitly. Start from the recommended tier and add as needed:

```ts
createVFS({
  backend,
  execute: {
    allowCommands: ['node', 'git'],
    envBlocklist: [
      // Code-injection vectors (recommended; no legitimate subprocess use)
      'LD_PRELOAD',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'BASH_ENV',
      'ENV',
      'SHELLOPTS',
      'PROMPT_COMMAND',
      'PS4',
      'GIT_CONFIG_PARAMETERS',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'ComSpec',
      'PATHEXT',
      // Secrets — exact names for known keys…
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'NPM_TOKEN',
      'DATABASE_URL',
      'MYSQL_PWD',
      // …and RegExp patterns to cover naming conventions
      /_TOKEN$/,
      /_SECRET$/,
      /_PASSWORD$/,
      // Proxy (only if the child must not inherit your proxy)
      /^(HTTP|HTTPS|NO|ALL)_PROXY$/i,
    ],
  },
})
```

Notes:
- **Exact names** match case-insensitively — `ComSpec` also blocks `COMSPEC`; `PATH` blocks `Path`.
- **RegExp patterns** are tested against the key in its original case — use the `/i` flag to be case-insensitive. Patterns let you cover naming conventions (`/_TOKEN$/` catches any future token var) but can also match non-secret config keys (e.g. `/^AWS_/` hits `AWS_REGION`) — verify your patterns against `printenv` output before deploying.
- `BASH_FUNC_<name>%%` entries (open set) cannot be enumerated; strip them in the host shell if that matters. A secret under an arbitrary name (`MY_PRIVATE_CREDS`) is only caught if it matches one of your patterns — keep secrets out of the host env for real isolation.
- Toolchain vars (`LD_LIBRARY_PATH`, `PYTHONPATH`, `VIRTUAL_ENV`) are intentionally omitted — normal operation often depends on them; block only if you know the child must not inherit them.

## `createVFS` Options

```ts
interface VFSConfig {
  backend: StorageBackend // required
  middleware?: Middleware[] // user middleware (onion, outermost first)
  limits?: Partial<{
    maxFileSize: number // default 10 MiB
    maxOutputBytes: number // default 1 MiB
    maxExecuteMs: number // default 60 000
    maxEditSize: number // default 1 MiB (capped at maxFileSize)
  }>
  signal?: AbortSignal // instance-wide, AND-ed with per-op signals
  debug?: boolean // emit structured logs to stderr
  debugger?: VFSDebugger // custom debug sink
  execute?: {
    allowCommands?: Array<string | RegExp> // command allow-list (default: disabled)
    envBlocklist?: Array<string | RegExp> // env vars stripped: exact names (case-insensitive) or patterns
  }
  cache?: CacheOptions | boolean // built-in cache; omitted/true = default-on
}
```

```ts
const vfs = createVFS({
  backend,
  limits: { maxFileSize: 4 * 1024 * 1024 },
  cache: { maxEntries: 64, maxValueBytes: 16 * 1024 * 1024 },
})
```

## Backends

### FilesystemBackend

```ts
const backend = new FilesystemBackend({ rootDir: './sandbox', virtualMode: true })
```

- `rootDir` is required; relative/virtual paths resolve under it.
- **Atomic writes**: writes go to a tmp file then `rename` — readers never observe partial content.
- **Symlink escape detection**: the deepest existing component is `realpath`-resolved and asserted inside `rootDir`.
- `virtualMode: true` rejects any host absolute path.
- Implements `execute` (detected via duck-typing); `dispose()` is a no-op.

### InMemoryBackend

```ts
const backend = new InMemoryBackend()
```

- Ephemeral `Map`-backed storage for tests and demos.
- No `execute` — `execute` ops return `UNSUPPORTED`.

## Middleware

Middleware run onion-style: the first entry runs first, wraps the next. Each must call `next()` exactly once.

```ts
import { createLoggingMiddleware, createPolicyMiddleware, createQuotaMiddleware } from '@loopflux/node-vfs'

const vfs = createVFS({
  backend,
  middleware: [
    createLoggingMiddleware({ log: entry => console.log(entry) }),
    createPolicyMiddleware({ deny: [/\/\./] }), // block all dotfiles
    createQuotaMiddleware({ maxBytes: 10 * 1024 * 1024 }),
  ],
})
```

| Middleware | Purpose |
|---|---|
| `createLoggingMiddleware` | Structured `start`/`end` events per op (opId-correlated, includes duration/bytes/exitCode) |
| `createPolicyMiddleware` | `deny: RegExp[]` — rejects direct access **and** filters denied entries from ls/glob/grep results |
| `createQuotaMiddleware` | In-memory byte-count quota for writes/edits/deletes (mutex-protected) |

## Built-in Cache

Configured via the `cache` field (not a user middleware). It sits just above the handler, **inside** user middleware, so policy-denied results never enter the cache.

- Query ops are cached; command ops invalidate affected entries (by `ancestorPaths`) on success. `execute` flushes the whole cache.
- Defaults: 256 entries, 64 MiB, TTL `read_file` 30s / `grep`/`ls`/`glob` 5s.
- `cache: false` disables it (lazy stream errors then surface during consumption).

```ts
createVFS({ backend, cache: false }) // disable
createVFS({ backend, cache: { maxEntries: 32 } }) // tune
```

## Error Codes

Stable contract surface — never rename. `ErrResult` carries `code`, `error`, and actionable `suggestions`.

| Code | Trigger |
|---|---|
| `NOT_FOUND` / `ALREADY_EXISTS` | Missing / existing path |
| `IS_DIRECTORY` / `NOT_DIRECTORY` | Type mismatch |
| `PATH_TRAVERSAL` | `..` segments, or a host path in virtual mode |
| `INVALID_PATH` | NUL/control chars, backslashes, malformed range |
| `PERMISSION_DENIED` | Policy deny, OS EACCES, or execute guard rejection |
| `OLD_TEXT_NOT_FOUND` / `AMBIGUOUS` | `edit_file` match cardinality |
| `CONFLICT` | `edit_file` concurrent modification (CAS) |
| `FILE_TOO_LARGE` / `OUTPUT_TOO_LARGE` | Size limits exceeded |
| `CAPACITY_EXCEEDED` | Quota middleware limit |
| `INVALID_PATTERN` | Bad grep/glob pattern |
| `EXEC_FAILED` / `COMMAND_NOT_FOUND` | Subprocess failures |
| `UNSUPPORTED` / `ABORTED` / `INTERNAL_ERROR` | Missing capability / cancellation / unexpected |

## Security Model

- **Default-deny execute**: an allow-list is required; the guard matches on command basename or `RegExp`.
- **Path validation chain**: `validatePath` (facade) → policy deny (middleware) → `assertInsideRoot` + symlink realpath (backend) — defense in depth.
- **Safe subprocess env**: the child inherits the full host `process.env` by default. Env hardening is caller-configured via `execute: { envBlocklist: [...] }` — list secrets/proxy vars you don't want to leak (case-insensitive matching). No implicit filtering.
- **Resource caps**: file size, output bytes, timeout, edit size, batch item count, pattern length, grep results.
- **Threat-model boundary**: the allow-list restricts the command *shape*, not arbitrary code (`node script.js`). For adversarial isolation, run in a container or sandboxed user.

## Toolkit

This package provides the raw engine. For LLM-facing tool definitions (zod schemas + descriptions), see [`@loopflux/node-vfs-toolkit`](../toolkit/README.md).
