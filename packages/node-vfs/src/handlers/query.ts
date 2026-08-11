/**
 * grep / ls / glob handlers — pure functions, import StorageBackend (type-only).
 * `buildLineMatcher` uses String.includes for plain-text (ReDoS-proof),
 * only invokes RegExp when flags are passed.
 */

import type { StorageBackend } from '../backend/storage.ts'
import type {
  ExecutionContext,
  GlobOp,
  GrepMatch,
  GrepMeta,
  GrepOp,
  ListEntry,
  ListMeta,
  LsOp,
  Result,
} from '../types.ts'
import { Buffer } from 'node:buffer'
import { err, ERR } from '../errors.ts'
import { decodeCursor, encodeCursor, hasTraversalSegments } from '../path.ts'
import { arrayToAsyncIterable, MAX_BATCH_ITEMS, processInBatches } from '../utils/batch.ts'
import { METADATA_OVERHEAD, TOKENS_PER_MATCH_LINE } from '../utils/tokens.ts'
import { OP_KIND } from './kinds.ts'

const DEFAULT_MAX_RESULTS = 1000
const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 1000
const BATCH_CONCURRENCY = 32
const GREP_CONCURRENCY = 8

const MAX_GREP_PATTERN_LEN = 4096
const MAX_GLOB_PATTERN_LEN = 4096
const ALLOWED_GREP_FLAGS = /^[gim]*$/

export interface LineMatcher {
  test: (line: string) => boolean
}

/**
 * Plain-text (no flags) → String.includes (ReDoS-proof, case-insensitive).
 * With flags → RegExp (g/i/m only).
 */
export function buildLineMatcher(pattern: string, flags: string = ''): LineMatcher {
  if (flags !== '' && !ALLOWED_GREP_FLAGS.test(flags)) {
    throw new SyntaxError(`Invalid grep flags "${flags}". Only g, i, m are allowed.`)
  }
  if (flags === '') {
    const needle = pattern.toLowerCase()
    return {
      test(line: string): boolean {
        return line.toLowerCase().includes(needle)
      },
    }
  }
  const baseFlags = flags.includes('g') ? flags : `${flags}g`
  const re = new RegExp(pattern, baseFlags)
  return {
    test(line: string): boolean {
      re.lastIndex = 0
      return re.test(line)
    },
  }
}

export async function handleGrep(
  backend: StorageBackend,
  op: GrepOp,
  ctx: ExecutionContext,
): Promise<Result<AsyncIterable<GrepMatch>, GrepMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())

  const stat = await backend.stat(op.path)
  if (!stat) {
    const meta: GrepMeta = {
      pattern: op.pattern,
      flags: op.flags ?? '',
      filesSearched: 0,
      filesTotal: 0,
      bytesRead: 0,
      matchCount: 0,
      truncated: false,
      truncateReason: null,
    }
    return { ok: true, data: arrayToAsyncIterable([]), meta, tokens: 0 }
  }

  let matcher: LineMatcher
  try {
    if (op.pattern === '') {
      return err(op.id, op.kind, ERR.INVALID_PATTERN('', 'Pattern must not be empty', OP_KIND.GREP))
    }
    if (op.pattern.length > MAX_GREP_PATTERN_LEN) {
      const reason = `Pattern too long (${op.pattern.length} chars, max ${MAX_GREP_PATTERN_LEN}). Shorten the pattern to reduce ReDoS risk.`
      return err(op.id, op.kind, ERR.INVALID_PATTERN(op.pattern.length > 100 ? `${op.pattern.slice(0, 100)}...` : op.pattern, reason, OP_KIND.GREP))
    }
    matcher = buildLineMatcher(op.pattern, op.flags ?? '')
  }
  catch (e) {
    const reason = e instanceof SyntaxError ? e.message : String(e)
    return err(op.id, op.kind, ERR.INVALID_PATTERN(op.pattern, reason, OP_KIND.GREP))
  }
  const maxResults = Math.max(1, op.maxResults ?? DEFAULT_MAX_RESULTS)

  let files: string[]
  if (stat.isDirectory) {
    const base = op.path === '/' ? '' : op.path
    const rels = await backend.globFiles(op.path, '**/*')
    files = rels.map(r => base ? `${base}/${r}` : `/${r}`)
  }
  else {
    files = [op.path]
  }

  if (files.length > MAX_BATCH_ITEMS) {
    return err(op.id, op.kind, ERR.TOO_MANY_FILES(files.length, MAX_BATCH_ITEMS))
  }

  let filesSearched = 0
  let bytesRead = 0
  const staged: Array<{ fileIndex: number, match: GrepMatch }> = []
  let truncated = false
  let truncateReason: 'maxResults' | 'fileSize' | null = null

  await processInBatches(files, GREP_CONCURRENCY, async (filePath, fileIndex) => {
    if (truncated || ctx.signal.aborted)
      return
    filesSearched++
    for await (const line of backend.readLines(filePath, ctx.signal)) {
      if (truncated)
        return
      bytesRead += Buffer.byteLength(line.text, 'utf8')
      if (matcher.test(line.text)) {
        staged.push({ fileIndex, match: { path: line.path, lineNumber: line.number, text: line.text } })
        if (staged.length >= maxResults) {
          truncated = true
          truncateReason = 'maxResults'
          return
        }
      }
      if (line.truncated) {
        truncated = true
        truncateReason = 'fileSize'
      }
    }
  }, ctx.signal)

  staged.sort((a, b) => {
    if (a.fileIndex !== b.fileIndex)
      return a.fileIndex - b.fileIndex
    return a.match.lineNumber - b.match.lineNumber
  })
  const matches: GrepMatch[] = staged.map(s => s.match)

  if (matches.length >= maxResults) {
    truncated = true
    truncateReason = 'maxResults'
    matches.length = Math.min(matches.length, maxResults)
  }

  const totalMatchBytes = matches.reduce((n, m) => n + Buffer.byteLength(m.text, 'utf8'), 0)
  const tokenSum = totalMatchBytes > 0
    ? Math.ceil(totalMatchBytes / 4)
    : matches.length * TOKENS_PER_MATCH_LINE
  const optimisticBound = maxResults * TOKENS_PER_MATCH_LINE
  const tokens = Math.min(optimisticBound, tokenSum)

  const meta: GrepMeta = {
    pattern: op.pattern,
    flags: op.flags ?? '',
    filesSearched,
    filesTotal: files.length,
    bytesRead,
    matchCount: matches.length,
    truncated,
    truncateReason,
  }
  return { ok: true, data: arrayToAsyncIterable(matches), meta, tokens }
}

export async function handleLs(
  backend: StorageBackend,
  op: LsOp,
  ctx: ExecutionContext,
): Promise<Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>> {
  return await handleListing(backend, op, ctx, OP_KIND.LS)
}

export async function handleGlob(
  backend: StorageBackend,
  op: GlobOp,
  ctx: ExecutionContext,
): Promise<Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>> {
  if (op.pattern.length > MAX_GLOB_PATTERN_LEN) {
    const reason = `Pattern too long (${op.pattern.length} chars, max ${MAX_GLOB_PATTERN_LEN}). Shorten the pattern to reduce ReDoS risk.`
    return err(op.id, op.kind, ERR.INVALID_PATTERN(
      op.pattern.length > 100 ? `${op.pattern.slice(0, 100)}...` : op.pattern,
      reason,
      OP_KIND.GLOB,
    ))
  }
  if (hasTraversalSegments(op.pattern)) {
    // '..' segments or backslashes would let fastGlob match files outside the
    // sandbox root. Reject here with an LLM-actionable error (the backend also
    // filters such matches as defense in depth).
    const reason = 'Pattern must not contain ".." segments or backslashes (glob stays inside the sandbox root)'
    return err(op.id, op.kind, ERR.INVALID_PATTERN(op.pattern, reason, OP_KIND.GLOB))
  }
  return await handleListing(backend, op, ctx, OP_KIND.GLOB)
}

async function handleListing(
  backend: StorageBackend,
  op: LsOp | GlobOp,
  ctx: ExecutionContext,
  kind: typeof OP_KIND.LS | typeof OP_KIND.GLOB,
): Promise<Result<{ entries: ListEntry[], nextCursor?: string }, ListMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())

  const stat = await backend.stat(op.path)
  if (!stat)
    return err(op.id, op.kind, ERR.NOT_FOUND(op.path))
  if (!stat.isDirectory)
    return err(op.id, op.kind, ERR.NOT_DIRECTORY(op.path))

  let offset = 0
  if (op.cursor) {
    const decoded = decodeCursor(op.cursor)
    if (!decoded) {
      // A malformed cursor must not masquerade as an empty directory — the
      // LLM cannot distinguish "no entries" from "bad cursor" otherwise.
      return err(op.id, op.kind, ERR.INVALID_CURSOR())
    }
    offset = decoded.o
  }

  let names: string[]
  if (kind === OP_KIND.LS) {
    names = await backend.listDir(op.path)
  }
  else {
    names = await backend.globFiles(op.path, (op as GlobOp).pattern)
  }

  if (names.length > MAX_BATCH_ITEMS) {
    return err(op.id, op.kind, ERR.TOO_MANY_FILES(names.length, MAX_BATCH_ITEMS))
  }

  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // code-point order for stable pagination

  const limit = Math.max(1, Math.min(op.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const page = names.slice(offset, offset + limit)

  const entries: ListEntry[] = []
  await processInBatches(page, BATCH_CONCURRENCY, async (name) => {
    if (ctx.signal.aborted)
      return
    const childPath = `${op.path === '/' ? '' : op.path}/${name}`
    const entryStat = await backend.stat(childPath)
    if (!entryStat)
      return
    entries.push({
      name,
      path: childPath,
      isDirectory: entryStat.isDirectory,
      size: entryStat.size,
      mtimeMs: entryStat.mtimeMs,
    })
  }, ctx.signal)

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const hasMore = offset + page.length < names.length
  const nextCursor = hasMore ? encodeCursor({ o: offset + page.length }) : undefined
  const meta: ListMeta = {
    path: op.path,
    truncated: false,
  }
  return {
    ok: true,
    data: { entries, nextCursor },
    meta,
    tokens: entries.length * METADATA_OVERHEAD,
  }
}
