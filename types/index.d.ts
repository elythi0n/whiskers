export type Edits = { files: number; added: number; removed: number }

export type Limit = { kind: string; percent: number }

export type Level = 'calm' | 'warm' | 'hot'

export type Burn = { perHour: number; level: Level; minutesLeft?: number }

export type Tokens = { bars: string; perMinute: number }

export type Line = {
  model?: string
  effort?: string
  limits: Limit[]
  contextPercent?: number
  edits?: Edits
  burn?: Burn
  tokens?: Tokens
}

declare module 'claude-code' {
  interface PluginState {
    whiskers: { line: Line }
  }
}
