export type CockpitLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type CockpitTurnRecord = {
  durationMs: number
  tools: number
  steps: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  cacheRead: number
  reason: string
}

export type CockpitTest = {
  command: string
  isOk: boolean
  passed?: number
  failed?: number
  at: number
}

export type CockpitDiffFile = { path: string; add: number; del: number }

export type CockpitGuardEvent = { command: string; reason: string; verdict: 'allowed' | 'blocked'; at: number }

export type CockpitAgent = {
  id: string
  type: string
  description: string
  name?: string
  status: string
  parentId?: string
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  errors: number
  toolCounts: Record<string, number>
  lastTool: string
  tokensIn: number
  tokensOut: number
  result?: string
}

export type CockpitCall = {
  tool: string
  label: string
  ms: number
  isError: boolean
  errorText?: string
  agentId?: string
  at: number
}

export type CockpitStats = {
  startedAt: number
  model: string
  cwd: string
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  limits: CockpitLimit[]
  /** a subscription was seen (now or in an earlier session) */
  isPlan?: boolean
  costUsd: number
  turnActive: boolean
  turnStartedAt: number
  turnSteps: number
  turnTools: number
  turnCostAtStart: number
  tools: Record<string, { calls: number; errors: number }>
  toolTotal: number
  toolErrors: number
  edits: Record<string, number>
  diff: CockpitDiffFile[]
  diffAdd: number
  diffDel: number
  lastTest: CockpitTest | null
  testRuns: number
  testFails: number
  turns: CockpitTurnRecord[]
  guardBlocked: number
  guardAllowed: number
  guardLog: CockpitGuardEvent[]
  warned: string[]
  lifetimeTurns: number
  lifetimeTools: number
  lifetimeUsd: number
  lifetimeSessions: number
  ctxParts: { name: string; tokens: number }[]
  cacheRead: number
  inputTotal: number
  toolMs: Record<string, { totalMs: number; maxMs: number }>
  slowest: { tool: string; ms: number; label: string } | null
  recentSigs: string[]
  loopSigs: string[]
  loopAlerts: number
  lastLoop: string
  agentsActive: string[]
  agentsSpawned: number
  compactions: number
  lastCompact: { before?: number; after?: number; trigger: string } | null
  limitStart: Record<string, { pct: number; at: number }>
  secretsBlocked: number
  agents: Record<string, CockpitAgent>
  turnLog: { tool: string; label: string; ms: number; isError: boolean; agentId?: string; at: number }[]
  testHistory: CockpitTest[]
  loopLog: { text: string; at: number }[]
  compactLog: { before?: number; after?: number; trigger: string; at: number }[]
  ctxFree: number
  ctxMemory: { path: string; tokens: number }[]
  ctxMcp: { server: string; tokens: number; tools: number }[]
  callLog: CockpitCall[]
  topOutputs: { tool: string; label: string; tokens: number; agentId?: string; at: number }[]
  lastResponseAt: number
  models: Record<string, { tokensIn: number; tokensOut: number; cacheRead: number; turns: number }>
  fileView: { path: string; lines: string[]; at: number } | null
}

export type CockpitPrefs = {
  isCompact: boolean
  isGuardOn: boolean
  isStatusOn: boolean
  isBandOn: boolean
  budgetUsd: number
  budgetMode: 'auto' | 'on' | 'off'
  isCostHidden: boolean
  isAgentsOpen: boolean
  agentOpen: string[]
  openSections: string[]
  toolOpen: string[]
  cacheTtlMin: number
}

export type CockpitPane = { isPlaced: boolean; reason: string }

declare module 'claude-code' {
  interface PluginState {
    cockpit: { stats: CockpitStats; prefs: CockpitPrefs; pane: CockpitPane }
  }
}
