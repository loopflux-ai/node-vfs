/**
 * Robust decoding for subprocess output.
 *
 * Windows cmd.exe / PowerShell emit the system's legacy ANSI code page
 * (GBK, Big5, Shift-JIS, EUC-KR, windows-125x, …) rather than UTF-8.
 * `decodeExecOutput` recovers the text by trying, in order: strict UTF-8,
 * UTF-8 with a truncated tail dropped, then the system ANSI code page
 * (registry ACP) or an explicitly provided encoding.
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { TextDecoder } from 'node:util'

/** Windows ANSI code page → WHATWG TextDecoder label. */
const CODE_PAGE_TO_LABEL: Readonly<Record<string, string>> = {
  '1250': 'windows-1250', // Central Europe
  '1251': 'windows-1251', // Cyrillic
  '1252': 'windows-1252', // Western Europe
  '1253': 'windows-1253', // Greek
  '1254': 'windows-1254', // Turkish
  '1255': 'windows-1255', // Hebrew
  '1256': 'windows-1256', // Arabic
  '1257': 'windows-1257', // Baltic
  '1258': 'windows-1258', // Vietnamese
  '874': 'windows-874',   // Thai
  '932': 'shift_jis',     // Japanese
  '936': 'gbk',           // Simplified Chinese
  '949': 'euc-kr',        // Korean
  '950': 'big5',          // Traditional Chinese
}

/** Map a numeric Windows code page to a TextDecoder label (pure, testable). */
export function codePageToLabel(codePage: string): string | undefined {
  return CODE_PAGE_TO_LABEL[codePage]
}

// undefined = not looked up yet; null = looked up, no usable result.
let cachedSystemAnsi: string | null | undefined

/**
 * The system ANSI code page as a TextDecoder label (e.g. 'gbk' on zh-CN),
 * or undefined when not Windows / lookup failed / code page unsupported.
 * A subprocess spawned via a pipe (no console handle) emits legacy ANSI
 * output using the *system* code page (registry ACP), not the caller's
 * terminal code page (`chcp`). The result is cached per process (one `reg`
 * spawn).
 */
export function systemAnsiLabel(): string | undefined {
  if (cachedSystemAnsi !== undefined)
    return cachedSystemAnsi ?? undefined
  cachedSystemAnsi = null
  if (process.platform !== 'win32')
    return undefined
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { encoding: 'utf8', timeout: 2000 },
    )
    if (r.status === 0 && r.stdout) {
      const m = /ACP\s+REG_SZ\s+(\d+)/.exec(r.stdout)
      const label = m ? codePageToLabel(m[1]) : undefined
      cachedSystemAnsi = label ?? null
      return label
    }
  }
  catch {
    // Fall through to the undefined result.
  }
  return undefined
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8Lenient = new TextDecoder('utf-8')

/** Build a decoder, returning undefined for unknown or unavailable labels. */
function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label)
    return undefined
  try {
    return new TextDecoder(label)
  }
  catch {
    return undefined
  }
}

/**
 * Decode bytes: clean UTF-8 passes through; a tail cut mid-sequence
 * (e.g. by maxBuffer truncation) is dropped, keeping the valid prefix;
 * anything else falls back to `fallback`.
 */
function decodeBytes(bytes: Uint8Array, fallback: TextDecoder | undefined): string {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
    bytes = bytes.subarray(3)

  try {
    return utf8Strict.decode(bytes)
  }
  catch {
    // Not valid UTF-8 — retry with a truncated tail, then the fallback.
  }

  for (let cut = 1; cut <= 3 && cut < bytes.length; cut++) {
    try {
      return utf8Strict.decode(bytes.subarray(0, bytes.length - cut))
    }
    catch {
      // Try a shorter cut.
    }
  }

  return (fallback ?? utf8Lenient).decode(bytes)
}

/**
 * Decode subprocess output.
 * - Strings and empty input pass through unchanged.
 * - `encoding` explicitly overrides detection (e.g. 'gbk').
 * - Otherwise: strict UTF-8 first, then the system ANSI code page.
 */
export function decodeExecOutput(
  raw: string | Uint8Array | undefined | null,
  encoding?: string,
): string {
  if (typeof raw === 'string')
    return raw
  if (raw === undefined || raw === null || raw.byteLength === 0)
    return ''
  return decodeBytes(raw, decoderFor(encoding) ?? decoderFor(systemAnsiLabel()))
}
