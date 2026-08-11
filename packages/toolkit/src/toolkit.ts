import type { ToolExecutionContext, VFS, VFSToolDefinition } from './types'
import { buildPathHint, PATH_HINT } from './constants'
import { ALL_TOOLS } from './tools'

export class VFSToolkit {
  private vfs: VFS
  private defaultContext: Partial<ToolExecutionContext>
  private readonly tools: readonly VFSToolDefinition[]

  constructor(
    vfs: VFS,
    defaultContext?: Partial<ToolExecutionContext>,
  ) {
    this.vfs = vfs
    this.defaultContext = defaultContext || {}
    // When the backend exposes sandbox metadata (rootDir, virtualMode), bake
    // it into tool descriptions so the LLM can translate host paths to virtual
    // paths without trial-and-error.
    const info = vfs.describe?.()
    const pathHint = buildPathHint(info)
    this.tools = pathHint === PATH_HINT
      ? ALL_TOOLS
      : ALL_TOOLS.map(t => ({
          ...t,
          description: t.description.replaceAll(PATH_HINT, pathHint),
        }))
  }

  /** Returns all tool definitions (read-only). The execute tool announces the host platform. */
  getTools(): readonly VFSToolDefinition[] {
    return this.tools
  }

  /** Find a tool by name. */
  getTool(name: string): VFSToolDefinition | undefined {
    return this.tools.find(t => t.name === name)
  }

  /** Execute a tool, merging dynamic context. */
  async executeTool<TInput>(
    tool: VFSToolDefinition<TInput>,
    input: TInput,
    context?: Partial<ToolExecutionContext>,
  ): Promise<string> {
    const fullContext: ToolExecutionContext = {
      vfs: this.vfs,
      cwd: this.defaultContext.cwd || '/',
      ...context,
    }
    return await tool.execute(input, fullContext)
  }
}
