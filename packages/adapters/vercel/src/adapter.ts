import type { createVFS } from '@loopflux/node-vfs'
import type { z } from 'zod'
import type { VercelAdapterOptions } from './types'
import { VFSToolkit } from '@loopflux/node-vfs-toolkit'
import { tool } from 'ai'

/**
 * Clean wrapper — exposes description and parameters metadata
 * alongside execute, without leaking ai.Tool's internal complexity.
 */
export interface VercelTool {
  description: string
  parameters: z.ZodSchema<Record<string, unknown>>
  execute: (input: Record<string, unknown>) => Promise<string>
}

export function toVercelTools(
  vfs: ReturnType<typeof createVFS>,
  options?: VercelAdapterOptions & { outputFormat?: 'object' },
): Record<string, VercelTool>
export function toVercelTools(
  vfs: ReturnType<typeof createVFS>,
  options: VercelAdapterOptions & { outputFormat: 'array' },
): VercelTool[]
export function toVercelTools(
  vfs: ReturnType<typeof createVFS>,
  options: VercelAdapterOptions = {},
): Record<string, VercelTool> | VercelTool[] {
  const toolkit = new VFSToolkit(vfs)
  const { prefix = '', filter, outputFormat = 'object' } = options

  let tools = toolkit.getTools()
  if (filter) {
    tools = tools.filter(t => filter(t.name))
  }

  const result: Record<string, VercelTool> = {}
  for (const toolDef of tools) {
    const name = prefix + toolDef.name
    const t = tool({
      description: toolDef.description,
      parameters: toolDef.schema,
      execute: async (input: unknown, _opts?: unknown): Promise<unknown> => {
        return await toolkit.executeTool(toolDef, input)
      },
    } as any)

    result[name] = {
      description: toolDef.description,
      parameters: toolDef.schema as z.ZodSchema<Record<string, unknown>>,
      execute: (input: Record<string, unknown>) => t.execute(input, {} as never) as Promise<string>,
    }
  }

  if (outputFormat === 'array') {
    return Object.values(result)
  }
  return result
}
