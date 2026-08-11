import type { VFSToolDefinition } from '../types'
import { deleteFileTool } from './deleteFile'
import { editFileTool } from './editFile'
import { executeTool } from './execute'
import { globTool } from './glob'
import { grepTool } from './grep'
import { lsTool } from './ls'
import { mkdirTool } from './mkdir'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'

export { deleteFileTool } from './deleteFile'
export { editFileTool } from './editFile'
export { executeTool } from './execute'
export { globTool } from './glob'
export { grepTool } from './grep'
export { lsTool } from './ls'
export { mkdirTool } from './mkdir'
export { readFileTool } from './readFile'
export { writeFileTool } from './writeFile'

/** All tools. */
export const ALL_TOOLS: readonly VFSToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  mkdirTool,
  grepTool,
  lsTool,
  globTool,
  executeTool,
]
