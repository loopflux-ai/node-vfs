export interface VercelAdapterOptions {
  /** Prefix prepended to each tool name (e.g. 'vfs_' → vfs_read_file). */
  prefix?: string
  /** Filter which tools to adapt. Return true to include. Defaults to all. */
  filter?: (toolName: string) => boolean
  /**
   * Output format.
   * - 'object' (default): Returns Record<string, Tool>, convenient for generateText tools param.
   * - 'array': Returns Tool[], useful for iteration or merging with other tools.
   */
  outputFormat?: 'object' | 'array'
}
