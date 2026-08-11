/** File handlers — pure functions, import StorageBackend (type-only). */

import type { StorageBackend } from '../backend/storage.ts'
import type {
  DeleteFileOp,
  DeleteMeta,
  DeleteResult,
  EditFileOp,
  EditMeta,
  EditResult,
  Encoding,
  ExecutionContext,
  FileContent,
  FileMeta,
  ReadFileOp,
  Result,
  WriteFileOp,
  WriteMeta,
  WriteResult,
} from '../types.ts'
import { Buffer } from 'node:buffer'
import { err, ERR, getBackendErrorCode } from '../errors.ts'
import { estimateBinaryTokens, estimateTextTokens } from '../utils/tokens.ts'

const HEX_RE = /^[0-9a-f]*$/i
const B64_RE = /^[A-Z0-9+/]*={0,2}$/i

/** Decode a string into bytes per the given encoding. Throws on malformed input. */
function decodeContent(content: string, encoding: Encoding): Uint8Array {
  if (encoding === 'utf8')
    return new TextEncoder().encode(content)
  if (encoding === 'hex') {
    if (content.length % 2 !== 0 || !HEX_RE.test(content))
      throw new Error('Invalid hex string')
    return new Uint8Array(Buffer.from(content, 'hex'))
  }
  if (encoding === 'base64') {
    if (!B64_RE.test(content))
      throw new Error('Invalid base64 string')
    const bin = Buffer.from(content, 'base64')
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength)
  }
  throw new Error(`Unknown encoding: ${encoding as string}`)
}

function decodeFileContent(content: FileContent, encoding: Encoding): Uint8Array {
  if (content instanceof Uint8Array)
    return content
  return decodeContent(content, encoding)
}

// Per-call TextDecoder avoids concurrent edit_file corruption from shared stream buffer.
async function drainUtf8(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8')
  const parts: string[] = []
  for await (const chunk of stream) {
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

export async function handleReadFile(
  backend: StorageBackend,
  op: ReadFileOp,
  ctx: ExecutionContext,
): Promise<Result<AsyncIterable<Uint8Array>, FileMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())

  const stat = await backend.stat(op.path)
  if (!stat)
    return err(op.id, op.kind, ERR.NOT_FOUND(op.path))
  if (stat.isDirectory)
    return err(op.id, op.kind, ERR.IS_DIRECTORY(op.path))

  const start = op.range?.start ?? 0
  const end = Math.min(op.range?.end ?? stat.size, stat.size)
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return err(op.id, op.kind, ERR.UNSUPPORTED(), { reason: 'range start/end must be integers' })
  }
  if (start < 0 || end < 0) {
    return err(op.id, op.kind, ERR.INVALID_PATH(op.path, 'range.start and range.end must be >= 0'))
  }
  if (start > end) {
    return err(op.id, op.kind, ERR.INVALID_PATH(op.path, 'range.start must be <= range.end'))
  }
  const rangeLen = Math.max(0, end - start)

  if (rangeLen > ctx.limits.maxFileSize) {
    return err(op.id, op.kind, ERR.FILE_TOO_LARGE(op.path, rangeLen, ctx.limits.maxFileSize))
  }

  const encoding: Encoding = op.encoding ?? 'utf8'

  if (rangeLen <= 0) {
    const empty = (async function* () {})()
    const meta: FileMeta = {
      size: stat.size,
      isDirectory: false,
      mtimeMs: stat.mtimeMs,
      encoding,
      range: { start, end },
      bytesReturned: 0,
      truncated: false,
    }
    return { ok: true, data: empty, meta, tokens: 0 }
  }

  const stream = backend.read(op.path, { start, end }, ctx.signal)
  const tokens = encoding === 'utf8' ? estimateTextTokens(rangeLen) : estimateBinaryTokens(rangeLen)
  const meta: FileMeta = {
    size: stat.size,
    isDirectory: false,
    mtimeMs: stat.mtimeMs,
    encoding,
    range: { start, end },
    bytesReturned: rangeLen,
    truncated: false,
  }
  const wrapped: AsyncIterable<Uint8Array> = {
    async* [Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          if (ctx.signal.aborted) {
            meta.truncated = true
            return
          }
          yield chunk
        }
        if (ctx.signal.aborted) {
          meta.truncated = true
        }
      }
      catch (e) {
        const code = e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
        if (code === 'ENOENT') {
          throw Object.assign(new Error('File not found'), { code: 'NOT_FOUND' })
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED' })
        }
        throw e
      }
    },
  }
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  return { ok: true, data: wrapped, meta, tokens }
}

export async function handleWriteFile(
  backend: StorageBackend,
  op: WriteFileOp,
  ctx: ExecutionContext,
): Promise<Result<WriteResult, WriteMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  if (op.path === '/')
    return err(op.id, op.kind, ERR.NOT_DIRECTORY('/'))

  const encoding: Encoding = op.encoding ?? 'utf8'
  let bytes: Uint8Array
  try {
    bytes = decodeFileContent(op.content, encoding)
  }
  catch (e) {
    return err(op.id, op.kind, ERR.UNSUPPORTED(), { reason: (e as Error).message })
  }

  if (bytes.byteLength > ctx.limits.maxFileSize) {
    return err(op.id, op.kind, ERR.FILE_TOO_LARGE(op.path, bytes.byteLength, ctx.limits.maxFileSize))
  }

  const existingStat = await backend.stat(op.path)
  if (op.mode === 'create' && existingStat) {
    if (existingStat.isDirectory)
      return err(op.id, op.kind, ERR.IS_DIRECTORY(op.path))
    return err(op.id, op.kind, ERR.ALREADY_EXISTS(op.path))
  }
  if (existingStat?.isDirectory)
    return err(op.id, op.kind, ERR.IS_DIRECTORY(op.path))

  // Check combined size before backend reads file into memory.
  if (op.mode === 'append' && existingStat) {
    const combined = existingStat.size + bytes.byteLength
    if (combined > ctx.limits.maxFileSize) {
      return err(op.id, op.kind, ERR.FILE_TOO_LARGE(op.path, combined, ctx.limits.maxFileSize))
    }
  }

  let receipt: Awaited<ReturnType<typeof backend.write>>
  try {
    receipt = await backend.write(op.path, bytes, op.mode)
  }
  catch (e) {
    const code = getBackendErrorCode(e)
    if (code === 'ALREADY_EXISTS')
      return err(op.id, op.kind, ERR.ALREADY_EXISTS(op.path))
    throw e
  }

  const writeResult: WriteResult = {
    path: op.path,
    bytesWritten: receipt.bytesWritten,
    deltaBytes: receipt.deltaBytes,
    mode: receipt.mode,
    ...(typeof op.content === 'string' ? { encoding } : {}),
  }
  return {
    ok: true,
    data: writeResult,
    meta: { bytesWritten: receipt.bytesWritten, deltaBytes: receipt.deltaBytes },
    tokens: 0,
  }
}

export async function handleEditFile(
  backend: StorageBackend,
  op: EditFileOp,
  ctx: ExecutionContext,
): Promise<Result<EditResult, EditMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  if (op.path === '/')
    return err(op.id, op.kind, ERR.NOT_DIRECTORY('/'))

  const stat = await backend.stat(op.path)
  if (!stat)
    return err(op.id, op.kind, ERR.NOT_FOUND(op.path))
  if (stat.isDirectory)
    return err(op.id, op.kind, ERR.IS_DIRECTORY(op.path))
  if (stat.size > ctx.limits.maxEditSize) {
    return err(op.id, op.kind, ERR.FILE_TOO_LARGE(op.path, stat.size, ctx.limits.maxEditSize, 'maxEditSize'))
  }

  if (op.oldText === '' || op.oldText.trim() === '') {
    return err(op.id, op.kind, ERR.OLD_TEXT_EMPTY())
  }

  const stream = backend.read(op.path, { start: 0, end: stat.size }, ctx.signal)
  const content = await drainUtf8(stream)
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())

  const idx = content.indexOf(op.oldText)
  if (idx === -1)
    return err(op.id, op.kind, ERR.OLD_TEXT_NOT_FOUND())
  const secondIdx = content.indexOf(op.oldText, idx + op.oldText.length)
  if (secondIdx !== -1)
    return err(op.id, op.kind, ERR.AMBIGUOUS())

  const newContent = content.slice(0, idx) + op.newText + content.slice(idx + op.oldText.length)
  const newBytes = new TextEncoder().encode(newContent)

  if (newBytes.byteLength > ctx.limits.maxEditSize) {
    return err(op.id, op.kind, ERR.FILE_TOO_LARGE(op.path, newBytes.byteLength, ctx.limits.maxEditSize, 'maxEditSize'))
  }

  // CAS (compare-and-swap): detect concurrent modification between the read
  // and the write. size+mtime is best-effort — a rewrite to the same size
  // could slip through — but it narrows the read-modify-write race window.
  const beforeWrite = await backend.stat(op.path)
  if (!beforeWrite || beforeWrite.size !== stat.size || beforeWrite.mtimeMs !== stat.mtimeMs) {
    return err(op.id, op.kind, ERR.CONFLICT(op.path))
  }

  await backend.write(op.path, newBytes, 'overwrite')

  const editResult: EditResult = {
    path: op.path,
    occurrences: 1,
    bytesWritten: newBytes.byteLength,
  }
  return {
    ok: true,
    data: editResult,
    meta: { occurrences: 1, bytesWritten: newBytes.byteLength },
    tokens: 0,
  }
}

export async function handleDeleteFile(
  backend: StorageBackend,
  op: DeleteFileOp,
  ctx: ExecutionContext,
): Promise<Result<DeleteResult, DeleteMeta>> {
  if (ctx.signal.aborted)
    return err(op.id, op.kind, ERR.ABORTED())
  if (op.path === '/')
    return err(op.id, op.kind, ERR.PERMISSION_DENIED(op.path), { reason: 'Cannot delete root' })

  const stat = await backend.stat(op.path)
  if (!stat)
    return err(op.id, op.kind, ERR.NOT_FOUND(op.path))

  if (stat.isDirectory && !op.recursive) {
    return err(op.id, op.kind, ERR.INVALID_PATH(op.path, 'Cannot delete directory without recursive flag'))
  }

  let result: { wasDirectory: boolean, bytesFreed: number }
  try {
    result = await backend.remove(op.path, op.recursive)
  }
  catch (e) {
    const code = getBackendErrorCode(e)
    if (code === 'NOT_FOUND')
      return err(op.id, op.kind, ERR.NOT_FOUND(op.path))
    throw e
  }

  const deleteResult: DeleteResult = {
    path: op.path,
    recursive: op.recursive ?? false,
  }
  return {
    ok: true,
    data: deleteResult,
    meta: {
      path: op.path,
      recursive: op.recursive ?? false,
      wasDirectory: result.wasDirectory,
      bytesFreed: result.bytesFreed,
    },
    tokens: 0,
  }
}
