export type Stats = {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftCount: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export type ContextRow = { name: string; tokens: number }

export type Context = {
  percent: number
  tokens: number
  window: number
  rows: ContextRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: Stats; context: Context | null; isHidden: boolean; isPinned: boolean }
  }
}
