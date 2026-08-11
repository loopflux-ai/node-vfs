import type { LogEntry, LogEntryEnd } from '../packages/node-vfs/src/middleware/logging'
/**
 * Integration tests: end-to-end agent workflows.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBackend } from '../packages/node-vfs/src/backend/memory'
import { createLoggingMiddleware } from '../packages/node-vfs/src/middleware/logging'
import { createPolicyMiddleware } from '../packages/node-vfs/src/middleware/policy'
import { createQuotaMiddleware } from '../packages/node-vfs/src/middleware/quota'
import { createVFS } from '../packages/node-vfs/src/vfs'
import { collect, expectErrResult, expectOkResult, readAll } from './helpers'

describe('agent workflow (InMemoryBackend)', () => {
  let vfs: ReturnType<typeof createVFS>
  let logs: LogEntry[]

  beforeEach(() => {
    logs = []
    vfs = createVFS({
      backend: new InMemoryBackend(),
      middleware: [
        createLoggingMiddleware({ log: entry => logs.push(entry) }),
        createPolicyMiddleware({ deny: [/\/\.git/] }),
        createQuotaMiddleware({ maxBytes: 1024 * 1024 }),
      ],
    })
  })

  it('should complete a full agent workflow: write → read → edit → grep → ls → delete', async () => {
    // 1. Create a file.
    const w = await vfs.write_file('/src/app.ts', 'const x = 1\nconst y = 2\nconst z = 3')
    expectOkResult(w)

    // 2. Read it back.
    const r = expectOkResult(await vfs.read_file('/src/app.ts'))
    expect(await readAll(r.data)).toContain('const x = 1')

    // 3. Edit a variable.
    expectOkResult(await vfs.edit_file('/src/app.ts', 'const x = 1', 'const x = 42'))

    // 4. Grep for a pattern.
    const g = expectOkResult(await vfs.grep('/src', 'const'))
    const matches = (await collect(g.data)).map(m => m.text)
    expect(matches).toHaveLength(3)
    expect(matches).toContain('const x = 42')

    // 5. List directory.
    const ls = expectOkResult(await vfs.ls('/src'))
    expect(ls.data.entries).toHaveLength(1)
    expect(ls.data.entries[0]!.name).toBe('app.ts')

    // 6. Delete the file.
    expectOkResult(await vfs.delete_file('/src/app.ts'))

    // 7. Verify file is gone.
    expectErrResult(await vfs.read_file('/src/app.ts'))

    // 8. All operations should have been logged (start+end per op); the final read failed.
    const ends = logs.filter((e): e is LogEntryEnd => e.phase === 'end')
    expect(ends).toHaveLength(7)
    expect(ends[6]!.ok).toBe(false)
    expect(ends[6]!.code).toBe('NOT_FOUND')
  })

  it('should block access to denied paths', async () => {
    await vfs.write_file('/.git/config', 'secret')
    await vfs.write_file('/public/readme.md', 'public')

    // Direct access to denied path should fail.
    expect(expectErrResult(await vfs.read_file('/.git/config')).code).toBe('PERMISSION_DENIED')

    // Public file should be accessible.
    expectOkResult(await vfs.read_file('/public/readme.md'))
  })

  it('should enforce quota across multiple writes', async () => {
    const smallVfs = createVFS({
      backend: new InMemoryBackend(),
      middleware: [createQuotaMiddleware({ maxBytes: 10 })],
    })

    // First write — within quota.
    expectOkResult(await smallVfs.write_file('/a.txt', 'hello'))

    // Second write — should exceed quota.
    expect(expectErrResult(await smallVfs.write_file('/b.txt', 'world!')).code).toBe('CAPACITY_EXCEEDED')
  })

  it('should handle concurrent reads safely', async () => {
    await Promise.all([
      vfs.write_file('/a.txt', 'aaa'),
      vfs.write_file('/b.txt', 'bbb'),
      vfs.write_file('/c.txt', 'ccc'),
    ])

    const results = await Promise.all([
      vfs.read_file('/a.txt'),
      vfs.read_file('/b.txt'),
      vfs.read_file('/c.txt'),
    ])
    for (const r of results) {
      expectOkResult(r)
    }
  })

  it('should keep policy-denied results out of the shared cache (middleware order contract)', async () => {
    // Cache is a built-in subsystem appended innermost by createVFS, so
    // passing only the policy places it outside the cache — denied reads
    // never reach the cache layer and are never persisted as entries.
    const ordered = createVFS({
      backend: new InMemoryBackend(),
      middleware: [createPolicyMiddleware({ deny: [/\/secret/] })],
    })

    await ordered.write_file('/secret.txt', 'classified')

    // Cache is populated with the ok result first...
    await ordered.write_file('/public.txt', 'public')
    expectOkResult(await ordered.read_file('/public.txt'))

    // ...but a policy-denied read never enters the cache.
    expect(expectErrResult(await ordered.read_file('/secret.txt')).code).toBe('PERMISSION_DENIED')
  })

  it('should invalidate cached lookups after writes across middleware layers', async () => {
    // Full stack: policy (user middleware) outside, built-in cache innermost;
    // a write must invalidate reads of the same path AND its ancestors.
    const full = createVFS({
      backend: new InMemoryBackend(),
      middleware: [createPolicyMiddleware({ deny: [/\/\.env/] })],
    })

    // 1. Cache a read.
    await full.write_file('/data/app.txt', 'v1')
    expect(await readAll(expectOkResult(await full.read_file('/data/app.txt')).data)).toBe('v1')

    // 2. Write to the same file (invalidates /data/app.txt and /data).
    await full.write_file('/data/app.txt', 'v2')

    // 3. Re-read — must observe v2, not the cached v1.
    expect(await readAll(expectOkResult(await full.read_file('/data/app.txt')).data)).toBe('v2')

    // 4. ls of the ancestor must also reflect the new directory state.
    await full.write_file('/data/new-file.txt', 'n')
    const ls = expectOkResult(await full.ls('/data'))
    expect(ls.data.entries.map(e => e.name).sort()).toEqual(['app.txt', 'new-file.txt'])
  })
})
