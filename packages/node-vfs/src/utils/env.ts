/**
 * Child-process env builder.
 *
 * Trust model: the child inherits the FULL host `process.env` by default
 * (no built-in allow-list or denylist). Callers may:
 * - override/add vars via `extra` (per-op `env`, wins over host values);
 * - remove host vars via `blocklist` (the `envBlocklist` configured on
 *   `createVFS({ execute: ... })`) — exact names (case-insensitive) or
 *   RegExp patterns.
 *
 * Blocking is the caller's responsibility: no key is filtered implicitly.
 *
 * The blocklist is the FINAL barrier: it is applied to the merged result
 * (host env ∪ per-op `extra`), so a blocklisted key is stripped even when a
 * caller explicitly passes it via `extra`. A per-op `env` cannot bypass the
 * configured blocklist.
 *
 * ── Suggested `envBlocklist` for reference (NOT enforced, caller decides) ──
 * The child env is only as clean as this list — start from the "recommended"
 * tier and add per your deployment:
 *
 *   // Code-injection vectors (recommended; no legitimate subprocess use)
 *   'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
 *   'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'SHELLOPTS',
 *   'PROMPT_COMMAND', 'PS4',
 *   'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
 *   'ComSpec', 'PATHEXT',
 *
 *   // Secrets (recommended — anything here is visible to the child).
 *   // Use exact names for known keys…
 *   'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
 *   'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN',
 *   'GITLAB_TOKEN', 'NPM_TOKEN', 'DATABASE_URL', 'MYSQL_PWD',
 *   // …and RegExp patterns to cover naming conventions. NOTE: patterns can
 *   // also match non-secret config keys (e.g. /^AWS_/ hits AWS_REGION) —
 *   // test your patterns against `printenv` output.
 *   /_TOKEN$/, /_SECRET$/, /_PASSWORD$/,
 *   /^(OPENAI|ANTHROPIC|GEMINI)_/,
 *
 *   // Proxy (only if the child must not inherit your proxy)
 *   /^(HTTP|HTTPS|NO|ALL)_PROXY$/i,   // covers upper/lower-case variants
 *
 *   // Toolchain (ONLY if the child should not inherit these — normal
 *   // operation often depends on them; do not block blindly)
 *   'LD_LIBRARY_PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'PYTHONHOME',
 *
 * Exact names match case-insensitively ('ComSpec' also blocks 'COMSPEC';
 * 'PATH' blocks 'Path'). RegExp patterns are tested against the key in its
 * original case — use the /i flag to be case-insensitive. bash exports
 * functions as 'BASH_FUNC_<name>%%' (open name set) — if that matters,
 * strip them in the host shell before launching the VFS process.
 */

/**
 * Build a child-process env from a host env, optional per-op overrides and an
 * optional user-supplied blocklist.
 *
 * Blocklist entries are either exact env-var names (matched case-insensitively)
 * or RegExp patterns (matched against the original key case, e.g.
 * `/_TOKEN$/`). Global/sticky flags are stripped so repeated `.test()` calls
 * stay deterministic.
 *
 * @param hostEnv The host environment (typically `process.env`).
 * @param extra Per-op env overrides; string values win over host values.
 * @param blocklist Exact env-var names or RegExp patterns to remove.
 */
export function buildChildEnv(
  hostEnv: Record<string, string | undefined>,
  extra?: Record<string, string>,
  blocklist?: readonly (string | RegExp)[],
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(hostEnv)) {
    if (typeof value === 'string')
      out[key] = value
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string')
        out[key] = value
    }
  }

  if (blocklist && blocklist.length > 0) {
    const exact = new Set<string>()
    const patterns: RegExp[] = []
    for (const item of blocklist) {
      if (item instanceof RegExp) {
        // Strip /g /y so test() does not advance lastIndex across keys.
        patterns.push(item.global || item.sticky
          ? new RegExp(item.source, item.flags.replace(/[gy]/g, ''))
          : item)
      }
      else {
        exact.add(item.toLowerCase())
      }
    }
    for (const key of Object.keys(out)) {
      const k = key.toLowerCase()
      if (exact.has(k) || patterns.some(re => re.test(key)))
        delete out[key]
    }
  }

  return out
}
