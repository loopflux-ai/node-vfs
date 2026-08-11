import type { SandboxInfo } from '@loopflux/node-vfs'

/** Max characters returned to the LLM in a single tool output (~12,500 tokens). */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000

/** Shared path semantics used by file tool descriptions. */
export const PATH_HINT = 'Path: "/foo" (virtual), "foo/bar" (relative, under rootDir); host absolute paths (e.g. "C:/foo") may be rejected depending on backend configuration'

/**
 * Builds a path hint for tool descriptions. When the backend exposes sandbox
 * metadata (rootDir, virtualMode), the hint includes the resolved root path so
 * the LLM can translate host paths to virtual paths without trial-and-error.
 *
 * rootDir is only exposed when virtualMode is true — when host paths are
 * rejected, the LLM needs the mapping to translate user-provided host paths.
 * When virtualMode is false, host paths are allowed directly; exposing rootDir
 * would mislead the LLM into translating paths that could be used as-is.
 */
export function buildPathHint(info?: SandboxInfo): string {
  if (!info?.rootDir) {
    return PATH_HINT
  }
  if (info.virtualMode) {
    return `Path: "/foo" (virtual), "foo/bar" (relative). Sandbox root "/" maps to "${info.rootDir}". Host absolute paths are rejected.`
  }
  return `Path: "/foo" (virtual), "foo/bar" (relative, under rootDir). Host absolute paths are allowed.`
}

/** Suffix appended when output is truncated. */
export const TRUNCATION_MARKER = `\n\n... [Truncated: output exceeded ${DEFAULT_MAX_OUTPUT_CHARS} characters]`

/** Shared env-semantics placeholder used by the execute tool description. */
export const ENV_HINT = 'Env: the child inherits the full host environment; per-op "env" vars are merged on top.'

/**
 * Builds the env hint for the execute tool description. When the VFS exposes
 * an env blocklist, the hint names the blocked vars/patterns so the LLM does
 * not waste calls passing values that will be silently stripped.
 */
export function buildEnvHint(info?: SandboxInfo): string {
  const blocklist = info?.envBlocklist
  if (!blocklist || blocklist.length === 0) {
    return ENV_HINT
  }
  const rendered = blocklist.map(item => typeof item === 'string' ? item : item.toString()).join(', ')
  return `Env: the child inherits the full host environment minus blocked vars/patterns: ${rendered}. Per-op "env" vars are merged on top but cannot bypass the blocklist.`
}

/** Why a result was truncated — drives the truncation note wording. */
export type TruncationReason = 'maxOutputChars' | 'maxFileSize' | 'maxOutputBytes' | 'maxResults'

/**
 * Build a reason-specific truncation note. The shared TRUNCATION_MARKER only
 * fits the maxOutputChars case; grep (4 MiB read cap / maxResults) and execute
 * (maxOutputBytes) must not tell the LLM the wrong reason.
 */
export function truncationNote(reason: TruncationReason): string {
  switch (reason) {
    case 'maxFileSize':
      return '\n\n... [Truncated: file search limited to the first 4 MiB]'
    case 'maxOutputBytes':
      return '\n\n... [Truncated: command output reached maxOutputBytes]'
    case 'maxResults':
      return '\n\n... [Truncated: results reached the maxResults limit]'
    default:
      return TRUNCATION_MARKER
  }
}
