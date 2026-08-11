import { describe, expect, it } from 'vitest'
import { buildEnvironmentPrompt, getSystemContext } from '../../packages/toolkit/src/system'

describe('getSystemContext', () => {
  it('should detect Windows platform', () => {
    const ctx = getSystemContext('win32')
    expect(ctx.platform).toBe('win32')
    expect(ctx.platformLabel).toBe('Windows')
    expect(ctx.isWindows).toBe(true)
    expect(ctx.shell).toBe('cmd')
  })

  it('should detect Linux platform', () => {
    const ctx = getSystemContext('linux')
    expect(ctx.platform).toBe('linux')
    expect(ctx.platformLabel).toBe('Linux')
    expect(ctx.isWindows).toBe(false)
    expect(ctx.shell).toBe('posix')
  })

  it('should detect macOS platform', () => {
    const ctx = getSystemContext('darwin')
    expect(ctx.platform).toBe('darwin')
    expect(ctx.platformLabel).toBe('macOS')
    expect(ctx.isWindows).toBe(false)
    expect(ctx.shell).toBe('posix')
  })

  it('should default to the real process platform', () => {
    const ctx = getSystemContext()
    expect(ctx.platform).toBe(process.platform)
  })
})

describe('buildEnvironmentPrompt', () => {
  it('should describe a Windows host', () => {
    const text = buildEnvironmentPrompt(getSystemContext('win32'))
    expect(text).toContain('Windows')
    expect(text).toContain('win32')
    expect(text).toContain('cmd')
  })

  it('should describe a POSIX host', () => {
    const text = buildEnvironmentPrompt(getSystemContext('linux'))
    expect(text).toContain('Linux')
    expect(text).toContain('POSIX shell')
  })
})
