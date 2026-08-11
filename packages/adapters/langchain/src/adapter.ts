import type { Tool, ToolRuntime } from '@langchain/core/tools'
import type { createVFS } from '@loopflux/node-vfs'
import type { LangChainAdapterOptions } from './types'
import { tool } from '@langchain/core/tools'
import { VFSToolkit } from '@loopflux/node-vfs-toolkit'

export function toLangChainTools(
  vfs: ReturnType<typeof createVFS>,
  options: LangChainAdapterOptions = {},
): Tool[] {
  const toolkit = new VFSToolkit(vfs)
  const { prefix = '', filter } = options

  let tools = toolkit.getTools()
  if (filter)
    tools = tools.filter(t => filter(t.name))

  return tools.map((toolDef) => {
    const name = prefix + toolDef.name
    return tool(
      async (input, runtime: ToolRuntime) => {
        const writer = runtime.writer
        if (writer) {
          writer(`[vfs] executing ${name}...`)
        }
        return await toolkit.executeTool(toolDef, input)
      },
      {
        name,
        description: toolDef.description,
        schema: toolDef.schema,
      },
    )
  })
}
