import type { createVFS } from '@loopflux/node-vfs'
import type { z } from 'zod'

export type VFS = ReturnType<typeof createVFS>

export interface ToolExecutionContext {
  vfs: VFS
  /** Only used by execute tool as the default working directory. */
  cwd?: string
}

export interface VFSToolDefinition<TInput = any, TOutput = string> {
  name: string
  description: string
  schema: z.ZodSchema<TInput>
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>
}
