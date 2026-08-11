/** Virtual path helpers — normalise, validate, paginate POSIX-style paths. */

import { Buffer } from 'node:buffer'
import { dirname, normalize } from 'pathe'

/**
 * Path kind after validation:
 * - `virtual` — VFS-relative path (starts with `/`, or a bare relative path
 *   like `foo/bar`). Resolved under the backend `rootDir`.
 * - `host` — host absolute path (Windows drive, e.g. `C:/foo` or `C:\foo`).
 *   Bypasses `rootDir` and refers to the real host path.
 */
export type PathKind = 'virtual' | 'host'

/** True when `path` is a Windows drive absolute path (e.g. `C:/foo`). */
export function isHostAbsolutePath(path: string): boolean {
  return /^[a-z]:\//i.test(path)
}

/**
 * Walk path up to its root, collecting ancestors.
 * `/a/b/c` → `['/a/b/c','/a/b','/a','/']`
 * `a/b`    → `['a/b','a','/']`
 * `C:/a/b` → `['C:/a/b','C:/a','C:/']`
 */
export function ancestorPaths(path: string): string[] {
  const paths: string[] = [path]
  let parent = dirname(path)
  while (parent !== '/' && parent !== '.' && parent !== '') {
    if (parent === paths[paths.length - 1])
      break
    paths.push(parent)
    parent = dirname(parent)
  }
  if (path !== '/' && !isHostAbsolutePath(path))
    paths.push('/')
  return paths
}

/** Discriminated union for `validatePath` results. */
export type PathValidationResult
  = | { ok: true, normalized: string, kind: PathKind }
    | { ok: false, code: 'PATH_TRAVERSAL' | 'INVALID_PATH' }

/** Pattern for VFS internal tmp files: `.vfs-tmp.*` */
const VFS_TMP_RE = /^\.vfs-tmp\./
/** Pattern for VFS internal backup files: `*.vfs-tmp.*.bak` */
const VFS_BAK_RE = /\.vfs-tmp\..*\.bak$/

/** Glob ignore patterns for VFS-internal files. */
export const INTERNAL_GLOB_IGNORE = ['**/.vfs-tmp.*', '**/*.vfs-tmp.*.bak']

/** True when `name` is a VFS-internal file (tmp/backup). */
export function isInternalFileName(name: string): boolean {
  return VFS_TMP_RE.test(name) || VFS_BAK_RE.test(name)
}

/**
 * True when a glob pattern or relative path contains `..` segments or
 * backslashes. Such values could resolve outside the sandbox root (fastGlob
 * happily matches `../file` from a cwd inside rootDir), so they are rejected
 * at the handler and filtered at the backend as defense in depth.
 */
export function hasTraversalSegments(value: string): boolean {
  return value.includes('\\') || value.split('/').includes('..')
}

/**
 * Validate a VFS path.
 *
 * Accepts three shapes:
 * - Virtual absolute path: `/a/b`
 * - Relative path: `a/b`, `./a` — treated as relative to the backend `rootDir`
 * - Host absolute path: `C:/a/b` or `C:\a\b` — bypasses `rootDir`
 *
 * Rejects NUL, `..` traversal, and backslashes in virtual paths.
 */
export function validatePath(path: string): PathValidationResult {
  if (!path || typeof path !== 'string') {
    return { ok: false, code: 'INVALID_PATH' }
  }
  if (path.includes('\0')) {
    return { ok: false, code: 'INVALID_PATH' }
  }
  // Reject control characters (tab, newline, carriage return, DEL, C1, etc.).
  // They corrupt logs and error messages, serve no legitimate purpose in any
  // path kind, and would otherwise flow through to ERR.* path interpolation.
  if (/\p{Cc}/u.test(path)) {
    return { ok: false, code: 'INVALID_PATH' }
  }

  // Windows drive path (`C:`, `C:/a`, `C:\a`) — host path, bypasses rootDir.
  // Checked before the virtual/relative branch so that `C:` — which pathe
  // normalizes to `C:/` — is consistently classified as a host path.
  if (/^[a-z]:/i.test(path)) {
    const forward = path.replace(/\\/g, '/')
    // `..` must be checked before normalize, which would otherwise collapse it.
    if (forward.split('/').includes('..')) {
      return { ok: false, code: 'PATH_TRAVERSAL' }
    }
    const normalized = normalize(forward)
    // `C:` collapses to `C:/` (ok); `C:foo` stays `C:foo` — ambiguous, reject.
    if (!/^[a-z]:\//i.test(normalized)) {
      return { ok: false, code: 'INVALID_PATH' }
    }
    return { ok: true, normalized, kind: 'host' }
  }

  // Virtual / relative path.
  if (path.includes('\\')) {
    return { ok: false, code: 'INVALID_PATH' }
  }
  // `..` before normalize — any occurrence is a traversal attempt.
  if (path.split('/').includes('..')) {
    return { ok: false, code: 'PATH_TRAVERSAL' }
  }
  const normalized = normalize(path)
  // Relative path resolving above the current directory.
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, code: 'PATH_TRAVERSAL' }
  }
  // `.` / `./` / `././` (empty after normalize) mean the current directory →
  // root. A literal `./` must collapse to `/` — otherwise paths like `./`
  // bypass the "cannot delete root" guard in handlers (op.path === '/').
  if (normalized === '.' || normalized === './' || normalized === '') {
    return { ok: true, normalized: '/', kind: 'virtual' }
  }
  return { ok: true, normalized, kind: 'virtual' }
}

export interface CursorPayload {
  o: number // offset into sorted name list
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as Partial<CursorPayload>
    if (typeof parsed.o !== 'number')
      return null
    // Reject malformed offsets.
    if (!Number.isInteger(parsed.o) || parsed.o < 0)
      return null
    return { o: parsed.o }
  }
  catch {
    return null
  }
}
