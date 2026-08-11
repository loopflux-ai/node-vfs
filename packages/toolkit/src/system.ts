import process from 'node:process'

export type VFSShell = 'cmd' | 'posix'

/** Host platform context, for letting an LLM agent know its execution environment. */
export interface VFSSystemContext {
  platform: NodeJS.Platform
  platformLabel: string
  arch: string
  isWindows: boolean
  shell: VFSShell
}

/** Read the current host platform. Pure; the platform can be injected for tests. */
export function getSystemContext(platform: NodeJS.Platform = process.platform): VFSSystemContext {
  const isWindows = platform === 'win32'
  const platformLabel = isWindows
    ? 'Windows'
    : platform === 'darwin'
      ? 'macOS'
      : platform === 'linux'
        ? 'Linux'
        : platform
  return {
    platform,
    platformLabel,
    arch: process.arch,
    isWindows,
    shell: isWindows ? 'cmd' : 'posix',
  }
}

/**
 * One-line environment summary for LLM-facing prompts.
 * Examples: "Host: Windows (win32, x64, cmd-compatible shell)".
 */
export function buildEnvironmentPrompt(ctx: VFSSystemContext): string {
  return `Host: ${ctx.platformLabel} (${ctx.platform}, ${ctx.arch}, ${ctx.shell === 'cmd' ? 'cmd-compatible shell' : 'POSIX shell'})`
}
