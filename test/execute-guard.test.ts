/**
 * Execute guard tests — default-deny allow-list model.
 */
import { describe, expect, it } from 'vitest'
import {
  buildExecuteGuard,
  parseCommandName,
} from '../packages/node-vfs/src/handlers/execute'

describe('parseCommandName', () => {
  it('should extract a bare command', () => {
    expect(parseCommandName('del')).toBe('del')
  })

  it('should extract the first token from a command line string', () => {
    expect(parseCommandName('del .env')).toBe('del')
    expect(parseCommandName('rm -rf /tmp')).toBe('rm')
  })

  it('should strip surrounding quotes', () => {
    expect(parseCommandName('"node" script.js')).toBe('node')
  })

  it('should strip path components and executable extensions', () => {
    expect(parseCommandName('C:\\Windows\\System32\\cmd.exe /c echo hi')).toBe('cmd')
    expect(parseCommandName('/usr/bin/rm -rf /tmp')).toBe('rm')
    expect(parseCommandName('node.exe --version')).toBe('node')
  })

  it('should parse a quoted path containing spaces', () => {
    expect(parseCommandName('"C:\\Program Files\\nodejs\\node.exe" -e x')).toBe('node')
    expect(parseCommandName('"C:\\Windows\\System32\\cmd.exe" /c del')).toBe('cmd')
  })

  it('should be case-insensitive', () => {
    expect(parseCommandName('DEL.EXE x')).toBe('del')
    expect(parseCommandName('PowerShell -Command x')).toBe('powershell')
  })
})

describe('buildExecuteGuard (default-deny allow-list)', () => {
  it('should deny every command by default (undefined or empty allow-list)', () => {
    for (const allow of [undefined, []]) {
      const guard = buildExecuteGuard(allow)
      for (const cmd of ['node script.js', 'npm run build', 'git status', 'echo hi', 'del x']) {
        const g = guard(cmd)
        expect(g.allowed, cmd).toBe(false)
        expect(g.reason, cmd).toBe('denyAll')
      }
    }
  })

  it('should allow listed command names and reject everything else', () => {
    const guard = buildExecuteGuard(['node', 'git'])
    expect(guard('node script.js').allowed).toBe(true)
    expect(guard('git status').allowed).toBe(true)
    const denied = guard('echo hi')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('allowList')
    expect(guard('del x').allowed).toBe(false)
  })

  it('should allow commands matching regex entries', () => {
    const guard = buildExecuteGuard([/^git/])
    expect(guard('git status').allowed).toBe(true)
    expect(guard('git push').allowed).toBe(true)
    expect(guard('node script.js').allowed).toBe(false)
  })

  it('should support mixed name and regex entries', () => {
    const guard = buildExecuteGuard(['node', /^git/])
    expect(guard('node script.js').allowed).toBe(true)
    expect(guard('git clone https://x').allowed).toBe(true)
    expect(guard('npm install').allowed).toBe(false)
  })

  it('should not be affected by global/sticky regex flags', () => {
    // /g mutates lastIndex — repeated checks must stay deterministic.
    const guard = buildExecuteGuard([/git/g])
    for (let i = 0; i < 3; i++) {
      expect(guard('git status').allowed).toBe(true)
      expect(guard('node script.js').allowed).toBe(false)
    }
  })

  it('should match names case-insensitively and ignore extensions', () => {
    const guard = buildExecuteGuard(['node'])
    expect(guard('NODE.EXE --version').allowed).toBe(true)
    expect(guard('"C:\\Program Files\\nodejs\\node.exe" --version').allowed).toBe(true)
  })

  it('should allow shell metacharacters in arguments of allowed commands', () => {
    // The guard matches the command name only — `|`, `;`, `&&`, `$()` are plain
    // arguments (execa runs with shell:false), so they are not blocked.
    const guard = buildExecuteGuard(['echo'])
    for (const cmd of ['echo a && echo b', 'echo a | echo b', 'echo a; echo b', 'echo a & echo b', 'echo `id`', 'echo $(whoami)']) {
      expect(guard(cmd).allowed, cmd).toBe(true)
    }
  })
})
