/**
 * Token estimation and op-id generation.
 * `tokens` on every Result lets LLM agents budget context before streaming.
 */

import { randomBytes } from 'node:crypto'

export const METADATA_OVERHEAD = 8
export const TOKENS_PER_MATCH_LINE = 20

export function estimateTextTokens(bytes: number): number {
  return Math.ceil(bytes / 4)
}

export function estimateBinaryTokens(bytes: number): number {
  return Math.ceil(bytes / 3)
}

/** Sortable, unique op-id: base36(timestamp) + random hex. */
export function generateOpId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(5).toString('hex')
  return `${ts}-${rand}`
}
