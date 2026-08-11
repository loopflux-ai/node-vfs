import type { createVFS } from '@loopflux/node-vfs'
import type { z } from 'zod'
import type { GoogleAdapterOptions } from './types'
import { FunctionTool } from '@google/adk'
import { VFSToolkit } from '@loopflux/node-vfs-toolkit'

export function toGoogleTools(
  vfs: ReturnType<typeof createVFS>,
  options: GoogleAdapterOptions = {},
): FunctionTool[] {
  const toolkit = new VFSToolkit(vfs)
  const { prefix = '', filter } = options

  let tools = toolkit.getTools()
  if (filter) {
    tools = tools.filter(t => filter(t.name))
  }

  return tools.map((toolDef) => {
    const name = prefix + toolDef.name
    return new FunctionTool({
      name,
      description: toolDef.description,
      parameters: toolDef.schema as z.ZodObject<z.ZodRawShape>,
      execute: async (input) => {
        return await toolkit.executeTool(toolDef, input)
      },
    })
  })
}
