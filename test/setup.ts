import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'

export async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'vfs-test-'))
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// Defense-in-depth: tests spy on `fsp` / `process.stderr` etc. via `vi.spyOn`.
// Per-test try/finally restore is the primary contract; this is the backstop
// so a forgotten `mockRestore()` cannot leak into the next test (the `forks`
// pool mitigates but does not eliminate cross-test contamination).
afterEach(() => {
  vi.restoreAllMocks()
})
