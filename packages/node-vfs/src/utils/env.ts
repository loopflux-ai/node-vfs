/**
 * Safe env builder for subprocess execution — allowlists SAFE_ENV_KEYS from
 * process.env, filters dangerous keys (LD_PRELOAD, DYLD_*, IFS, SHELL, …).
 */

import process from 'node:process'

const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'SystemRoot',
  'LANG',
  'LC_ALL',
])

const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
  // POSIX / Linux
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK',
  'LD_HWCAP_MASK',
  'LD_ORIGIN_PATH',
  'LD_POINTER_GUARD',
  'LD_PROFILE',
  'LD_SHOW_AUXV',
  'LD_USE_LOAD_BIAS',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASH_XTRACEFD',
  'BASH_COMPAT',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'RUBYOPT',
  'PERL5OPT',
  'PERL_USE_UNSAFE_INC',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'IFS',
  'SHELL',
  'HOSTALIASES',
  'LOCALDOMAIN',
  'RESOLV_HOST_CONF',
  'MSYS2_ARG_CONV_EXCL',
  // Windows
  'ComSpec', // Path to cmd.exe — hijacking enables arbitrary command execution
  'COMSPEC', // Case-insensitive variant
  'PATHEXT', // Controls which extensions are considered executable
  'WINDIR', // Windows system directory
  'PROMPT', // Command prompt format (can inject ANSI sequences)
  'PROCESSOR_ARCHITECTURE', // May affect binary selection
])

/** Build child-process env from safe keys + filtered extra. */
export function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const src = process.env ?? {}
  for (const key of SAFE_ENV_KEYS) {
    const v = src[key]
    if (typeof v === 'string')
      out[key] = v
  }
  if (extra) {
    for (const [key, v] of Object.entries(extra)) {
      if (typeof v !== 'string')
        continue
      if (DANGEROUS_ENV_KEYS.has(key) || key.startsWith('BASH_FUNC_'))
        continue
      out[key] = v
    }
  }
  return out
}
