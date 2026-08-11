export interface GoogleAdapterOptions {
  /** Prefix prepended to each tool name (e.g. 'vfs_' → vfs_read_file). */
  prefix?: string
  /** Filter which tools to adapt. Return true to include. Defaults to all. */
  filter?: (toolName: string) => boolean
}
