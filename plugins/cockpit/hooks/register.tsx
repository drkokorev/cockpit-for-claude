import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { CockpitAgent, CockpitCall, CockpitDiffFile, CockpitPane, CockpitPrefs, CockpitStats, CockpitTest, CockpitTurnRecord } from '../types'

// Agent Cockpit: a live instrument panel for Claude Code sessions.
// Context fill, rate limits, cost, the running turn, tool usage, edited files,
// test runs, turn history, all-time totals, and a guard for risky commands.

const PANE = 'cockpit'
const STORE_LIFETIME = 'lifetime'

const EMPTY_STATS: CockpitStats = {
  startedAt: 0,
  model: '',
  cwd: '',
  ctxWindow: 0,
  limits: [],
  costUsd: 0,
  turnActive: false,
  turnStartedAt: 0,
  turnSteps: 0,
  turnTools: 0,
  turnCostAtStart: 0,
  tools: {},
  toolTotal: 0,
  toolErrors: 0,
  edits: {},
  diff: [],
  diffAdd: 0,
  diffDel: 0,
  lastTest: null,
  testRuns: 0,
  testFails: 0,
  turns: [],
  guardBlocked: 0,
  guardAllowed: 0,
  guardLog: [],
  warned: [],
  lifetimeTurns: 0,
  lifetimeTools: 0,
  lifetimeUsd: 0,
  lifetimeSessions: 0,
  ctxParts: [],
  cacheRead: 0,
  inputTotal: 0,
  toolMs: {},
  slowest: null,
  recentSigs: [],
  loopSigs: [],
  loopAlerts: 0,
  lastLoop: '',
  agentsActive: [],
  agentsSpawned: 0,
  compactions: 0,
  lastCompact: null,
  limitStart: {},
  secretsBlocked: 0,
  agents: {},
  turnLog: [],
  testHistory: [],
  loopLog: [],
  compactLog: [],
  ctxFree: 0,
  ctxMemory: [],
  ctxMcp: [],
  callLog: [],
  topOutputs: [],
  lastResponseAt: 0,
  models: {},
  fileView: null,
}

const stats = atom({ plugin: 'cockpit', key: 'stats' } as const, EMPTY_STATS)
const DEFAULT_PREFS: CockpitPrefs = {
  isCompact: false,
  isGuardOn: true,
  isStatusOn: true,
  isBandOn: false,
  budgetUsd: 0,
  budgetMode: 'auto',
  isCostHidden: false,
  isAgentsOpen: true,
  agentOpen: [],
  openSections: [],
  toolOpen: [],
  cacheTtlMin: 5,
}
const prefs = atom({ plugin: 'cockpit', key: 'prefs' } as const, DEFAULT_PREFS)
const pane = atom({ plugin: 'cockpit', key: 'pane' } as const, { isPlaced: false, reason: '' } as CockpitPane)

// ---------- risky command patterns (the guard) ----------

const RISKS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[a-zA-Z]*R[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*R)\b/, reason: 'recursive force delete' },
  { pattern: /\brm\s+.*--recursive\b.*--force\b|\brm\s+.*--force\b.*--recursive\b/, reason: 'recursive force delete' },
  { pattern: /\bgit\s+push\b.*(\s--force(\s|$)|\s-f(\s|$))/, reason: 'force push rewrites remote history' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'discards uncommitted work' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: 'deletes untracked files' },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, reason: 'discards all local changes' },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: 'force-deletes a branch' },
  { pattern: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: 'destroys database data' },
  { pattern: /\bchmod\s+-R\s+777\b/, reason: 'opens permissions on a whole tree' },
  { pattern: /\b(mkfs(\.\w+)?|fdisk|diskutil\s+erase\w*)\b/, reason: 'formats a disk' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: 'writes raw bytes to a device' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: 'pipes a download straight into a shell' },
  { pattern: /(^|[;&|]\s*)sudo\s/, reason: 'runs as root' },
  { pattern: /\bkubectl\s+delete\b/, reason: 'deletes cluster resources' },
  { pattern: /\bterraform\s+(destroy|apply\b.*-auto-approve)/, reason: 'changes infrastructure without review' },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'publishes a package' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
]

const TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpx\s+(jest|vitest|playwright\s+test|mocha)\b|\b(jest|vitest|pytest|rspec|phpunit|mocha)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b|\bmix\s+test\b|\bdotnet\s+test\b|\bdeno\s+test\b|\bmake\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const SECRET_FILE =
  /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|[\w.-]+\.(pem|key|p12|pfx|keystore))$/i

// What makes two tool calls "the same" for the loop detector.
const signatureOf = (tool: string, args: Record<string, unknown>) => {
  const key = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'path']
    .map(name => args[name])
    .find(value => typeof value === 'string')
  return `${tool}:${typeof key === 'string' ? key.slice(0, 200) : ''}`
}

// A subscription reports rate-limit windows; API-key billing does not.
const isSubscription = (s: CockpitStats) => s.limits.length > 0

const isBudgetVisible = (p: CockpitPrefs, s: CockpitStats) =>
  !p.isCostHidden && p.budgetUsd > 0 && (p.budgetMode === 'on' || (p.budgetMode === 'auto' && !isSubscription(s)))

const newAgent = (id: string, now: number): CockpitAgent => ({
  id,
  type: '',
  description: '',
  status: 'running',
  startedAt: now,
  steps: 0,
  tools: 0,
  errors: 0,
  toolCounts: {},
  lastTool: '',
  tokensIn: 0,
  tokensOut: 0,
})

// Agents the list never names (compaction and memory forks) and that called no tool stay hidden.
const visibleAgents = (s: CockpitStats) =>
  Object.values(s.agents ?? {})
    .filter(a => a.type !== '' || a.tools > 0)
    .sort((a, b) => b.startedAt - a.startedAt)

const LOOP_WINDOW = 8
const LOOP_REPEATS = 3

// ---------- formatting ----------

const fmtTokens = (n?: number) =>
  n === undefined ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const fmtUsd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

const fmtDur = (ms: number) => {
  if (ms > 0 && ms < 100) return '<0.1s'
  if (ms > 0 && ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}:${String(sec % 60).padStart(2, '0')}`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

const fmtAgo = (ms: number) => (ms < 60_000 ? 'just now' : `${fmtDur(ms)} ago`)

const bar = (pct: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const sparkline = (values: number[]) => {
  const max = Math.max(1, ...values)
  return values.map(v => SPARKS.at(Math.min(7, Math.floor((v / max) * 7))) ?? '▁').join('')
}

const levelColor = (pct: number) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green')

const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind

const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : `resets in ${fmtDur(Math.max(0, at - now))}`
}

const relPath = (path: string, cwd: string) =>
  cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path

const shorten = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

// ---------- state helpers ----------

type Dollar = EngineInterface
type CockpitElements = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button'>

const pushStatus = async ($: Dollar) => {
  const p = await read($, prefs)
  if (!p.isStatusOn) {
    $.ui.status(undefined)
    return
  }
  const s = await read($, stats)
  const parts = [`ctx ${s.ctxPercent === undefined ? '—' : `${s.ctxPercent}%`}`]
  const fiveHour = s.limits.find(l => l.kind === 'five_hour')
  if (fiveHour) parts.push(`5h ${Math.round(fiveHour.percentUsed)}%`)
  if (!p.isCostHidden) parts.push(isBudgetVisible(p, s) ? `${fmtUsd(s.costUsd)}/${fmtUsd(p.budgetUsd)}` : fmtUsd(s.costUsd))
  const running = visibleAgents(s).filter(a => a.status === 'running').length
  if (running) parts.push(`${running} agent${running > 1 ? 's' : ''}`)
  parts.push(`${s.toolTotal} tools`)
  if (s.turnActive) parts.push('working')
  $.ui.status(`◆ ${parts.join(' · ')}`)
}

const warnOnce = async ($: Dollar) => {
  const s = await read($, stats)
  const due: { id: string; text: string }[] = []
  const pct = s.ctxPercent ?? 0
  if (pct >= 95) due.push({ id: 'ctx95', text: `Context ${pct}% full: compaction is imminent` })
  else if (pct >= 80) due.push({ id: 'ctx80', text: `Context ${pct}% full: consider /compact soon` })
  for (const limit of s.limits) {
    if (limit.percentUsed >= 90) due.push({ id: `lim90:${limit.kind}`, text: `${limitLabel(limit.kind)} limit ${Math.round(limit.percentUsed)}% used` })
    else if (limit.percentUsed >= 75) due.push({ id: `lim75:${limit.kind}`, text: `${limitLabel(limit.kind)} limit ${Math.round(limit.percentUsed)}% used` })
  }
  const p = await read($, prefs)
  if (isBudgetVisible(p, s)) {
    const share = (s.costUsd / p.budgetUsd) * 100
    if (share >= 100) due.push({ id: `budget100:${p.budgetUsd}`, text: `budget ${fmtUsd(p.budgetUsd)} reached (${fmtUsd(s.costUsd)} spent)` })
    else if (share >= 80) due.push({ id: `budget80:${p.budgetUsd}`, text: `${Math.round(share)}% of the ${fmtUsd(p.budgetUsd)} budget spent` })
  }
  const fresh = due.filter(d => !s.warned.includes(d.id))
  if (fresh.length === 0) return
  await update($, stats, cur => ({ ...cur, warned: [...cur.warned, ...fresh.map(d => d.id)] }))
  for (const d of fresh) $.ui.toast(`Cockpit: ${d.text}`, { timeoutMs: 6000 })
}

const applyUsage = async (
  $: Dollar,
  usage: { context: { tokens?: number; window: number; percent?: number }; rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]; cost?: { usd: number } },
) => {
  await update($, stats, s => ({
    ...s,
    ctxTokens: usage.context.tokens,
    ctxWindow: usage.context.window,
    ctxPercent: usage.context.percent,
    limits: usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: usage.cost?.usd ?? s.costUsd,
  }))
  const now = await $.clock.now()
  await update($, stats, s => {
    const limitStart = { ...(s.limitStart ?? {}) }
    for (const l of usage.rateLimits) {
      const first = limitStart[l.kind]
      // a window that reset (percent fell) starts its pace sample over
      if (!first || l.percentUsed < first.pct) limitStart[l.kind] = { pct: l.percentUsed, at: now }
    }
    return { ...s, limitStart }
  })
  await warnOnce($)
  await pushStatus($)
}

const refreshUsage = async ($: Dollar) => {
  try {
    const usage = await $.session.usage()
    const model = await $.session.model()
    await update($, stats, s => ({ ...s, model }))
    await applyUsage($, usage)
  } catch (error) {
    $.ui.log(`cockpit: usage unavailable (${String(error)})`, { to: 'debug' })
  }
}

const refreshBreakdown = async ($: Dollar) => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    const categories = breakdown?.categories ?? []
    const parts = categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)
      .map(c => ({ name: c.name, tokens: c.tokens }))
    const free = categories.filter(c => c.kind === 'free').reduce((sum, c) => sum + c.tokens, 0)
    const memory = (breakdown?.memoryFiles ?? [])
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6)
      .map(m => ({ path: m.path, tokens: m.tokens }))
    const servers: Record<string, { tokens: number; tools: number }> = {}
    for (const tool of breakdown?.mcpTools ?? []) {
      const cur = servers[tool.serverName] ?? { tokens: 0, tools: 0 }
      servers[tool.serverName] = { tokens: cur.tokens + tool.tokens, tools: cur.tools + 1 }
    }
    const mcp = Object.entries(servers)
      .map(([server, v]) => ({ server, tokens: v.tokens, tools: v.tools }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6)
    await update($, stats, s => ({ ...s, ctxParts: parts, ctxFree: free, ctxMemory: memory, ctxMcp: mcp }))
  } catch {
    // breakdown unavailable on this host
  }
}

// Minutes until a rate-limit window fills at the pace seen this session.
const paceEta = (s: CockpitStats, kind: string, now: number) => {
  const limit = s.limits.find(l => l.kind === kind)
  const first = s.limitStart?.[kind]
  if (!limit || !first || now - first.at < 5 * 60_000) return undefined
  const perMs = (limit.percentUsed - first.pct) / (now - first.at)
  if (perMs <= 0) return undefined
  return (100 - limit.percentUsed) / perMs
}

const burnPerHour = (s: CockpitStats, now: number) => {
  const hours = (now - s.startedAt) / 3_600_000
  return s.startedAt && hours > 0.05 ? s.costUsd / hours : undefined
}

const cacheShare = (s: CockpitStats) =>
  s.inputTotal > 0 ? Math.round((s.cacheRead / s.inputTotal) * 100) : undefined

const refreshAgents = async ($: Dollar) => {
  try {
    const list = await $.agent.list()
    const now = await $.clock.now()
    await update($, stats, s => {
      const agents = { ...(s.agents ?? {}) }
      for (const info of list) {
        const cur = agents[info.id] ?? newAgent(info.id, now)
        agents[info.id] = {
          ...cur,
          type: info.type,
          description: info.description,
          name: info.name,
          status: info.status,
          parentId: info.parentId,
          endedAt: info.status !== 'running' && !cur.endedAt ? now : cur.endedAt,
        }
      }
      // keep the 20 most recent
      const kept = Object.values(agents).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)
      return { ...s, agents: Object.fromEntries(kept.map(a => [a.id, a])) }
    })
  } catch {
    // agent list unavailable
  }
}

const parseNumstat = (text: string): CockpitDiffFile[] =>
  text
    .split('\n')
    .map(line => line.split('\t'))
    .filter(cols => cols.length >= 3)
    .map(cols => ({
      path: cols.slice(2).join('\t'),
      add: Number(cols.at(0)) || 0,
      del: Number(cols.at(1)) || 0,
    }))

const refreshDiff = async ($: Dollar) => {
  try {
    let run = await $.process.run(['git', 'diff', '--numstat', 'HEAD'], { timeoutMs: 5000 })
    if (run.exitCode !== 0) run = await $.process.run(['git', 'diff', '--numstat'], { timeoutMs: 5000 })
    if (run.exitCode !== 0) return
    const files = parseNumstat(run.stdout)
    const untracked = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard'], { timeoutMs: 5000 })
    if (untracked.exitCode === 0) {
      for (const path of untracked.stdout.split('\n').filter(Boolean).slice(0, 50)) {
        files.push({ path, add: -1, del: 0 })
      }
    }
    await update($, stats, s => ({
      ...s,
      diff: files.slice(0, 100),
      diffAdd: files.reduce((sum, f) => sum + Math.max(0, f.add), 0),
      diffDel: files.reduce((sum, f) => sum + f.del, 0),
    }))
  } catch {
    // not a git repository, or git is missing: the files section falls back to edits
  }
}

const checkRisk = (command: string) => RISKS.find(r => r.pattern.test(command))?.reason

const parseTestOutput = (text: string) => {
  const passed = text.match(/(\d+)\s+(passed|passing)\b/i)
  const failed = text.match(/(\d+)\s+(failed|failing)\b/i)
  return {
    passed: passed ? Number(passed[1]) : undefined,
    failed: failed ? Number(failed[1]) : undefined,
  }
}

const buildReport = (s: CockpitStats, now: number) => {
  const lines = [`Cockpit report · session ${fmtDur(now - s.startedAt)} · ${s.model || 'model ?'}`]
  lines.push(`Context: ${s.ctxPercent ?? '—'}% (${fmtTokens(s.ctxTokens)} / ${fmtTokens(s.ctxWindow)})`)
  for (const l of s.limits) lines.push(`Limit ${limitLabel(l.kind)}: ${l.percentUsed}% ${resetIn(l.resetsAt, now)}`)
  lines.push(`Cost: ${fmtUsd(s.costUsd)} · turns: ${s.turns.length} · tool calls: ${s.toolTotal} (${s.toolErrors} errors)`)
  const top = Object.entries(s.tools).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8)
  if (top.length) lines.push(`Tools: ${top.map(([name, t]) => `${name} ${t.calls}`).join(', ')}`)
  const files = s.diff.length ? s.diff.map(f => `${f.path} ${f.add < 0 ? 'new' : `+${f.add} -${f.del}`}`) : Object.entries(s.edits).map(([p, n]) => `${relPath(p, s.cwd)} (${n} edits)`)
  if (files.length) lines.push(`Files: ${files.slice(0, 12).join(', ')}`)
  if (s.lastTest) lines.push(`Tests: ${s.testRuns} runs, ${s.testFails} failed; last ${s.lastTest.isOk ? 'passed' : 'failed'} (${s.lastTest.command})`)
  const cache = cacheShare(s)
  const burn = burnPerHour(s, now)
  lines.push(`Pace: ${burn === undefined ? '—' : `${fmtUsd(burn)}/h`} · prompt cache hits ${cache === undefined ? '—' : `${cache}%`}`)
  if (s.ctxParts?.length) lines.push(`Context parts: ${s.ctxParts.map(c => `${c.name} ${fmtTokens(c.tokens)}`).join(', ')}`)
  if (s.slowest) lines.push(`Slowest tool call: ${s.slowest.tool} ${fmtDur(s.slowest.ms)} (${s.slowest.label})`)
  lines.push(`Subagents: ${s.agentsSpawned} spawned · compactions: ${s.compactions} · loop alerts: ${s.loopAlerts}`)
  for (const a of visibleAgents(s).slice(0, 10)) {
    lines.push(`  ${a.status === 'running' ? '●' : a.status === 'completed' ? '✓' : '✗'} ${a.type || 'agent'} "${a.description}" · ${fmtDur((a.endedAt ?? now) - a.startedAt)} · ${a.tools} tools · ${fmtTokens(a.tokensIn)} in`)
  }
  lines.push(`Guard: ${s.guardBlocked} blocked, ${s.guardAllowed} allowed, ${s.secretsBlocked} secret-file edits stopped`)
  lines.push(`All-time: ${s.lifetimeSessions} sessions · ${s.lifetimeTurns} turns · ${s.lifetimeTools} tools · ${fmtUsd(s.lifetimeUsd)}`)
  return lines.join('\n')
}

const buildMarkdown = (s: CockpitStats, now: number) => {
  const turns = s.turns
    .map((t, i) => `| ${i + 1} | ${fmtDur(t.durationMs)} | ${t.steps} | ${t.tools} | ${fmtTokens(t.tokensIn)} | ${fmtTokens(t.tokensOut)} | ${fmtUsd(t.costUsd)} | ${t.reason} |`)
    .join('\n')
  const tools = Object.entries(s.tools)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([name, t]) => `| ${name} | ${t.calls} | ${t.errors} | ${fmtDur(s.toolMs?.[name]?.totalMs ?? 0)} |`)
    .join('\n')
  return [
    `# Cockpit report`,
    '',
    '```',
    buildReport(s, now),
    '```',
    '',
    '## Turns',
    '',
    '| # | Duration | Steps | Tools | In | Out | Cost | End |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    turns || '| – | | | | | | | |',
    '',
    '## Tools',
    '',
    '| Tool | Calls | Errors | Time |',
    '| --- | --- | --- | --- |',
    tools || '| – | | | |',
    '',
    `_Generated by Cockpit for Claude Code on ${new Date(now).toISOString()}_`,
    '',
  ].join('\n')
}

const exportReport = async ($: Dollar) => {
  const s = await read($, stats)
  const now = await $.clock.now()
  const root = s.cwd || (await $.session.cwd())
  try {
    // one fixed file, relative to the session's working directory; each export replaces it
    await $.fs.write('.cockpit/cockpit-report.md', buildMarkdown(s, now))
    return `Cockpit report saved to ${root}/.cockpit/cockpit-report.md`
  } catch (error) {
    return `Cockpit could not save the report: ${String(error)}`
  }
}

// The full cockpit tree, drawn in the side panel or in the expanded band.
const drawCockpit = async ($: Dollar, els: CockpitElements, bodyColumns: number) => {
  const { Box, Text, Button } = els
  const s = await read($, stats)
  const p = await read($, prefs)
  const now = await $.clock.now()
  const cols = Math.max(30, bodyColumns || 60)
  const barWidth = Math.max(8, Math.min(24, cols - 26))
  const labelWidth = 12
  const mini = (share: number, width = 10) => bar(Math.max(0, Math.min(100, share)), width)
  const pad = (text: string, width: number) => (text.length >= width ? text.slice(0, width - 1) + ' ' : text.padEnd(width))
  const nameWidth = Math.max(10, Math.min(22, cols - labelWidth - 30))

  const isOpen = (label: string) => p.openSections.includes(label)
  const toggleSection = (label: string) =>
    update($, prefs, cur => ({
      ...cur,
      openSections: cur.openSections.includes(label) ? cur.openSections.filter(x => x !== label) : [...cur.openSections, label],
    }))

  // A section: its label opens the details, which show under the summary.
  const row = (label: string, body: RenderChildren, details?: () => RenderChildren, onToggle?: () => unknown, isToggled?: boolean) => (
    <Box flexDirection="row">
      <Box width={labelWidth} flexShrink={0}>
        {details || onToggle ? (
          <Button
            key={`sec-${label}`}
            plain
            dimColor={!(onToggle ? isToggled : isOpen(label))}
            label={`${(onToggle ? isToggled : isOpen(label)) ? '▾' : '▸'} ${label}`}
            onPress={() => (onToggle ? onToggle() : toggleSection(label))}
          />
        ) : (
          <Text dimColor bold>{`  ${label}`}</Text>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {body}
        {details && isOpen(label) ? (
          <Box flexDirection="column" paddingLeft={1} marginBottom={1} borderStyle="single" borderColor="gray" borderDimColor>
            {details()}
          </Box>
        ) : null}
      </Box>
    </Box>
  )

  const line = (...parts: { text: string; color?: string; dim?: boolean; bold?: boolean }[]) => (
    <Box flexDirection="row">
      {parts.map(part => (
        <Text color={part.color} dimColor={part.dim} bold={part.bold} wrap="truncate-end">
          {part.text}
        </Text>
      ))}
    </Box>
  )

  // context
  const pct = s.ctxPercent
  const contextBody =
    pct === undefined
      ? line({ text: 'waiting for the first response', dim: true })
      : [
          line(
            { text: bar(pct, barWidth), color: levelColor(pct) },
            { text: ` ${pct}%`, bold: true, color: levelColor(pct) },
            { text: `  ${fmtTokens(s.ctxTokens)} / ${fmtTokens(s.ctxWindow)}`, dim: true },
          ),
          s.ctxParts.length > 0
            ? line({ text: s.ctxParts.slice(0, 4).map(c => `${c.name.toLowerCase()} ${fmtTokens(c.tokens)}`).join(' · '), dim: true })
            : null,
          pct >= 70 && !s.turnActive ? (
            <Box flexDirection="row" gap={1}>
              <Button key="compact-now" variant="primary" label="Compact now" onPress={() => $.command.run({ command: 'compact' })} />
              <Text dimColor>summarize the history before it happens mid-task</Text>
            </Box>
          ) : null,
        ]

  // limits
  const limitsBody =
    s.limits.length === 0
      ? line({ text: 'no rate-limit data (API key or no response yet)', dim: true })
      : s.limits.map(l =>
          line(
            { text: `${limitLabel(l.kind).padEnd(5)} ` },
            { text: bar(l.percentUsed, Math.max(6, barWidth - 6)), color: levelColor(l.percentUsed) },
            { text: ` ${Math.round(l.percentUsed)}%`, bold: true },
            { text: `  ${resetIn(l.resetsAt, now)}`, dim: true },
            (() => {
              const eta = paceEta(s, l.kind, now)
              const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
              if (eta === undefined) return { text: '' }
              const isBeforeReset = Number.isNaN(resetsAt) || now + eta < resetsAt
              return isBeforeReset ? { text: ` · full in ${fmtDur(eta)} at this pace`, color: 'yellow' } : { text: ' · on pace', dim: true }
            })(),
          ),
        )

  // cost
  const lastTurn = s.turns.at(-1)
  const burn = burnPerHour(s, now)
  const cache = cacheShare(s)
  const budgetShare = isBudgetVisible(p, s) ? (s.costUsd / p.budgetUsd) * 100 : undefined
  const costBody = [
    line(
      { text: fmtUsd(s.costUsd), bold: true },
      { text: isSubscription(s) ? ' API value (covered by your plan)' : ' this session', dim: true },
      { text: lastTurn ? ` · ${fmtUsd(lastTurn.costUsd)} last turn` : '', dim: true },
    ),
    (() => {
      const left = cacheLeftMs(s, p, now)
      if (left === undefined) return null
      if (s.turnActive) return line({ text: '◉ cache in use', color: 'green' })
      return left > 0
        ? line({ text: `◉ cache warm ${fmtDur(left)}`, color: left > 60_000 ? 'green' : 'yellow' }, { text: ' · reply before it expires to keep requests cheap', dim: true })
        : line({ text: '○ cache expired', color: 'yellow' }, { text: ' · the next request re-reads the whole context at full price', dim: true })
    })(),
    line(
      { text: burn === undefined ? 'pace —' : `pace ${fmtUsd(burn)}/h`, dim: true },
      { text: cache === undefined ? '' : ` · cache hits ${cache}%`, color: cache === undefined ? undefined : cache >= 70 ? 'green' : cache >= 40 ? 'yellow' : 'red' },
    ),
    budgetShare === undefined
      ? null
      : line(
          { text: `budget ${bar(Math.min(100, budgetShare), Math.max(6, barWidth - 7))}`, color: levelColor(budgetShare) },
          { text: ` ${Math.round(budgetShare)}% of ${fmtUsd(p.budgetUsd)}`, bold: budgetShare >= 80 },
        ),
  ]

  // the running turn
  const turnBody = s.turnActive
    ? line(
        { text: '● working ', color: 'cyan', bold: true },
        { text: fmtDur(now - s.turnStartedAt) },
        { text: ` · ${s.turnSteps} steps · ${s.turnTools} tools`, dim: true },
        { text: s.agentsActive.length ? ` · ${s.agentsActive.length} subagent${s.agentsActive.length > 1 ? 's' : ''}` : '', color: 'magenta' },
      )
    : line(
        { text: '○ idle', dim: true },
        { text: lastTurn ? ` · last ${fmtDur(lastTurn.durationMs)}, ${lastTurn.tools} tools, ${fmtTokens(lastTurn.tokensIn)} in / ${fmtTokens(lastTurn.tokensOut)} out` : '', dim: true },
      )

  const header = line(
    { text: '◆ COCKPIT', bold: true, color: 'cyan' },
    { text: `  ${s.model || ''}`, dim: true },
    { text: s.startedAt ? `  · ${fmtDur(now - s.startedAt)}` : '', dim: true },
  )

  const controls = (
    <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
      <Button
        key="sections"
        hotkey="x"
        label={p.openSections.length ? 'Collapse all' : 'Expand all'}
        onPress={() =>
          update($, prefs, cur => ({
            ...cur,
            openSections: cur.openSections.length ? [] : ['CONTEXT', 'LIMITS', 'COST', 'TURN', 'TOOLS', 'FILES', 'TESTS', 'GUARD', 'ALERTS', 'HISTORY', 'ALL-TIME'],
          }))
        }
      />
      <Button key="compact" hotkey="c" label={p.isCompact ? 'Full view' : 'Compact'} onPress={() => update($, prefs, cur => ({ ...cur, isCompact: !cur.isCompact }))} />
      <Button
        key="guard"
        hotkey="g"
        variant={p.isGuardOn ? 'primary' : 'secondary'}
        label={p.isGuardOn ? 'Guard: on' : 'Guard: off'}
        onPress={() => update($, prefs, cur => ({ ...cur, isGuardOn: !cur.isGuardOn }))}
      />
      <Button
        key="status"
        hotkey="s"
        label={p.isStatusOn ? 'Status line: on' : 'Status line: off'}
        onPress={async () => {
          await update($, prefs, cur => ({ ...cur, isStatusOn: !cur.isStatusOn }))
          await pushStatus($)
        }}
      />
      <Button
        key="money"
        hotkey="m"
        label={p.isCostHidden ? 'Cost: hidden' : 'Cost: shown'}
        onPress={async () => {
          await update($, prefs, cur => ({ ...cur, isCostHidden: !cur.isCostHidden }))
          await pushStatus($)
        }}
      />
      <Button
        key="budget"
        hotkey="b"
        label={`Budget: ${p.budgetMode}${p.budgetUsd > 0 ? ` ${fmtUsd(p.budgetUsd)}` : ''}`}
        onPress={async () => {
          await update($, prefs, cur => ({ ...cur, budgetMode: (cur.budgetMode === 'auto' ? 'on' : cur.budgetMode === 'on' ? 'off' : 'auto') as CockpitPrefs['budgetMode'] }))
          await pushStatus($)
        }}
      />
      <Button
        key="report"
        hotkey="p"
        label="Report"
        onPress={async () => {
          const cur = await read($, stats)
          $.ui.log(buildReport(cur, await $.clock.now()))
        }}
      />
      <Button key="export" hotkey="e" label="Export .md" onPress={async () => $.ui.toast(await exportReport($), { timeoutMs: 8000 })} />
      <Button
        key="reset"
        hotkey="r"
        dimColor
        label="Reset"
        onPress={async () => {
          await update($, stats, cur => ({
            ...EMPTY_STATS,
            startedAt: cur.startedAt,
            model: cur.model,
            cwd: cur.cwd,
            ctxTokens: cur.ctxTokens,
            ctxWindow: cur.ctxWindow,
            ctxPercent: cur.ctxPercent,
            limits: cur.limits,
            costUsd: cur.costUsd,
            turnActive: cur.turnActive,
            turnStartedAt: cur.turnStartedAt,
            turnCostAtStart: cur.turnCostAtStart,
            diff: cur.diff,
            diffAdd: cur.diffAdd,
            diffDel: cur.diffDel,
            lifetimeTurns: cur.lifetimeTurns,
            lifetimeTools: cur.lifetimeTools,
            lifetimeUsd: cur.lifetimeUsd,
            lifetimeSessions: cur.lifetimeSessions,
          }))
          await pushStatus($)
        }}
      />
    </Box>
  )

  if (p.isCompact) {
    return (
      <Box flexDirection="column">
        {header}
        {row('CONTEXT', contextBody)}
        {row('LIMITS', limitsBody)}
        {p.isCostHidden ? null : row('COST', costBody)}
        {row('TURN', turnBody)}
        {controls}
      </Box>
    )
  }

  // tools
  const topTools = Object.entries(s.tools)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 6)
  const toolsBody =
    topTools.length === 0
      ? line({ text: 'no tool calls yet', dim: true })
      : [
          line({ text: topTools.map(([name, t]) => `${name.replace(/^mcp__[^_]+__/, '')} ${t.calls}`).join(' · ') }),
          line(
            { text: `${s.toolTotal} calls`, dim: true },
            { text: s.toolErrors ? ` · ${s.toolErrors} errors` : '', color: s.toolErrors ? 'red' : undefined },
            { text: s.slowest && s.slowest.ms >= 1000 ? ` · slowest ${s.slowest.tool} ${fmtDur(s.slowest.ms)}` : '', dim: true },
          ),
        ]

  // files
  const fileRows: RenderChildren[] = []
  if (s.diff.length > 0) {
    for (const f of s.diff.slice(0, 6)) {
      fileRows.push(
        line(
          { text: shorten(f.path, Math.max(12, cols - labelWidth - 14)) },
          f.add < 0 ? { text: '  new', color: 'cyan' } : { text: `  +${f.add}`, color: 'green' },
          f.add < 0 ? { text: '' } : { text: ` −${f.del}`, color: 'red' },
        ),
      )
    }
    fileRows.push(
      line({ text: `${s.diff.length} files · +${s.diffAdd} −${s.diffDel} vs HEAD`, dim: true }),
    )
  } else {
    const edited = Object.entries(s.edits).sort((a, b) => b[1] - a[1])
    if (edited.length === 0) fileRows.push(line({ text: 'no edits yet', dim: true }))
    for (const [path, count] of edited.slice(0, 6)) {
      fileRows.push(line({ text: shorten(relPath(path, s.cwd), Math.max(12, cols - labelWidth - 12)) }, { text: `  ${count} edits`, dim: true }))
    }
  }

  // tests
  const testBody = s.lastTest
    ? [
        line(
          { text: s.lastTest.isOk ? '✓ passed' : '✗ failed', color: s.lastTest.isOk ? 'green' : 'red', bold: true },
          { text: s.lastTest.passed !== undefined ? ` · ${s.lastTest.passed} passed` : '' },
          { text: s.lastTest.failed ? ` · ${s.lastTest.failed} failed` : '', color: 'red' },
          { text: ` · ${fmtAgo(now - s.lastTest.at)}`, dim: true },
        ),
        line({ text: `${s.lastTest.command} · ${s.testRuns} runs, ${s.testFails} failed`, dim: true }),
      ]
    : line({ text: 'no test runs seen yet', dim: true })

  // guard
  const lastGuard = s.guardLog.at(-1)
  const guardBody = [
    line(
      { text: p.isGuardOn ? 'on' : 'off', color: p.isGuardOn ? 'green' : 'yellow', bold: true },
      { text: ` · ${s.guardBlocked} blocked · ${s.guardAllowed} allowed`, dim: true },
      { text: s.secretsBlocked ? ` · ${s.secretsBlocked} secret edits stopped` : '', color: 'yellow' },
    ),
    lastGuard
      ? line(
          { text: lastGuard.verdict === 'blocked' ? '✗ ' : '✓ ', color: lastGuard.verdict === 'blocked' ? 'red' : 'yellow' },
          { text: shorten(lastGuard.command, Math.max(12, cols - labelWidth - 4)), dim: true },
        )
      : line({ text: 'watching rm -rf, force push, reset --hard, sudo, .env and key files…', dim: true }),
  ]

  // agents: one line each, details on demand
  const agents = visibleAgents(s)
  const runningCount = agents.filter(a => a.status === 'running').length
  const agentCard = (a: CockpitAgent) => {
    const isOpen = p.agentOpen.includes(a.id)
    const isRunning = a.status === 'running'
    const took = (a.endedAt ?? now) - a.startedAt
    const mark = isRunning ? '●' : a.status === 'completed' ? '✓' : '✗'
    const markColor = isRunning ? 'magenta' : a.status === 'completed' ? 'green' : 'red'
    const title = a.description || a.name || a.id.slice(0, 8)
    const topTools = Object.entries(a.toolCounts).sort((x, y) => y[1] - x[1]).slice(0, 5)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button
            key={`agent-${a.id}`}
            plain
            dimColor={!isOpen}
            label={isOpen ? '▾' : '▸'}
            onPress={() =>
              update($, prefs, cur => ({
                ...cur,
                agentOpen: cur.agentOpen.includes(a.id) ? cur.agentOpen.filter(id => id !== a.id) : [...cur.agentOpen, a.id].slice(-10),
              }))
            }
          />
          <Text color={markColor}>{mark}</Text>
          <Text bold>{a.type || 'agent'}</Text>
          <Text wrap="truncate-end">{shorten(title, Math.max(10, cols - labelWidth - 34))}</Text>
          <Text dimColor>{`${fmtDur(took)} · ${a.tools} tools`}</Text>
        </Box>
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={4}>
            {line({ text: `${a.status} · ${a.steps} steps · ${fmtTokens(a.tokensIn)} in / ${fmtTokens(a.tokensOut)} out`, dim: true }, { text: a.errors ? ` · ${a.errors} errors` : '', color: 'red' })}
            {topTools.length ? line({ text: `tools: ${topTools.map(([name, n]) => `${name.replace(/^mcp__[^_]+__/, '')} ${n}`).join(' · ')}`, dim: true }) : null}
            {a.lastTool ? line({ text: `last: ${shorten(a.lastTool, Math.max(12, cols - labelWidth - 12))}`, dim: true }) : null}
            {a.name || a.parentId ? line({ text: [a.name ? `name ${a.name}` : '', a.parentId ? `spawned by ${a.parentId.slice(0, 8)}` : 'spawned by main'].filter(Boolean).join(' · '), dim: true }) : null}
            {(() => {
              const calls = (s.callLog ?? []).filter(c => c.agentId === a.id).slice(-8)
              return calls.length
                ? [
                    line({ text: 'timeline', bold: true }),
                    ...calls.map(c =>
                      line(
                        { text: c.isError ? '✗ ' : '✓ ', color: c.isError ? 'red' : 'green' },
                        { text: pad(c.tool.replace(/^mcp__[^_]+__/, ''), 10), bold: true },
                        { text: pad(fmtDur(c.ms), 6), dim: true },
                        { text: shorten(c.label, Math.max(10, cols - labelWidth - 26)), dim: true },
                      ),
                    ),
                  ]
                : null
            })()}
            {a.result ? line({ text: 'result: ', bold: true }, { text: shorten(a.result, Math.max(20, (cols - labelWidth - 14) * 2)), dim: true }) : null}
          </Box>
        ) : null}
      </Box>
    )
  }
  const agentsBody =
    agents.length === 0
      ? line({ text: 'no subagents yet', dim: true })
      : [
          <Box flexDirection="row" gap={1}>
            <Text>{`${agents.length} total`}</Text>
            <Text color={runningCount ? 'magenta' : undefined} dimColor={!runningCount}>{`${runningCount} running`}</Text>
            <Button
              key="agents-toggle"
              plain
              dimColor
              hotkey="a"
              label={p.isAgentsOpen ? 'hide list' : 'show list'}
              onPress={() => update($, prefs, cur => ({ ...cur, isAgentsOpen: !cur.isAgentsOpen }))}
            />
          </Box>,
          p.isAgentsOpen ? agents.slice(0, 6).map(agentCard) : null,
        ]

  // alerts: loops, compactions, subagents
  const alertLines = [
    s.loopAlerts
      ? line({ text: `⟳ ${s.loopAlerts} loop alert${s.loopAlerts > 1 ? 's' : ''}`, color: 'yellow', bold: true }, { text: ` · ${shorten(s.lastLoop, Math.max(10, cols - labelWidth - 18))}`, dim: true })
      : null,
    s.compactions
      ? line({ text: `${s.compactions} compaction${s.compactions > 1 ? 's' : ''}`, color: 'cyan' }, { text: s.lastCompact ? ` · last ${fmtTokens(s.lastCompact.before)} → ${fmtTokens(s.lastCompact.after)} (${s.lastCompact.trigger})` : '', dim: true })
      : null,
  ].filter(Boolean)
  const alertsBody = alertLines.length ? alertLines : line({ text: 'no loops or compactions yet', dim: true })

  // history
  const recent = s.turns.slice(-10)
  const historyBody =
    recent.length === 0
      ? line({ text: 'no finished turns yet', dim: true })
      : [
          line({ text: sparkline(recent.map(t => t.tokensIn)), color: 'cyan' }, { text: '  input tokens per turn', dim: true }),
          line({
            text: recent
              .slice(-3)
              .map(t => `${fmtDur(t.durationMs)} ${t.tools}t ${fmtUsd(t.costUsd)}`)
              .join(' · '),
            dim: true,
          }),
        ]


  // ---------- details, drawn only for an open section ----------

  const hogLines = (limit: number) =>
    (s.topOutputs ?? []).slice(0, limit).map(o =>
      line(
        { text: pad(`~${fmtTokens(o.tokens)}`, 8), color: o.tokens >= 10_000 ? 'red' : o.tokens >= 3000 ? 'yellow' : undefined, bold: true },
        { text: pad(o.tool.replace(/^mcp__[^_]+__/, ''), 9) },
        { text: o.agentId ? '↳ ' : '', color: 'magenta' },
        { text: shorten(o.label || '(no input)', Math.max(10, cols - labelWidth - 24)), dim: true },
      ),
    )

  const contextDetails = () => [
    line({ text: `${s.model || 'model'} · window ${fmtTokens(s.ctxWindow)} · free ${fmtTokens(s.ctxFree || (s.ctxWindow - (s.ctxTokens ?? 0)))}`, dim: true }),
    ...s.ctxParts.map(c =>
      line(
        { text: pad(c.name, nameWidth) },
        { text: mini(s.ctxWindow ? (c.tokens / s.ctxWindow) * 100 : 0), color: 'cyan' },
        { text: ` ${fmtTokens(c.tokens)}`, dim: true },
      ),
    ),
    (s.topOutputs ?? []).length ? line({ text: 'biggest tool outputs (context hogs)', bold: true }) : null,
    ...hogLines(3),
    s.ctxMemory.length ? line({ text: 'memory files', bold: true }) : null,
    ...s.ctxMemory.map(m => line({ text: pad(shorten(relPath(m.path, s.cwd), nameWidth), nameWidth) }, { text: fmtTokens(m.tokens), dim: true })),
    s.ctxMcp.length ? line({ text: 'MCP servers (tool schemas)', bold: true }) : null,
    ...s.ctxMcp.map(m => line({ text: pad(m.server, nameWidth) }, { text: `${fmtTokens(m.tokens)} · ${m.tools} tools`, dim: true })),
    line({
      text: (s.ctxPercent ?? 0) >= 80 ? 'tip: run /compact now, before it runs on its own mid-task' : 'tip: /context draws the full grid',
      color: (s.ctxPercent ?? 0) >= 80 ? 'yellow' : undefined,
      dim: (s.ctxPercent ?? 0) < 80,
    }),
  ]

  const limitsDetails = () =>
    s.limits.length === 0
      ? [line({ text: 'Rate-limit windows are reported on a Pro or Max subscription after the first response.', dim: true })]
      : s.limits.map(l => {
          const first = s.limitStart?.[l.kind]
          const hours = first ? (now - first.at) / 3_600_000 : 0
          const perHour = first && hours > 0.08 ? (l.percentUsed - first.pct) / hours : undefined
          const eta = paceEta(s, l.kind, now)
          return [
            line({ text: `${limitLabel(l.kind)} window`, bold: true }, { text: ` · ${l.percentUsed}% used · ${resetIn(l.resetsAt, now) || 'reset time unknown'}`, dim: true }),
            line({
              text:
                perHour === undefined
                  ? '  pace: measuring (needs a few minutes)'
                  : `  pace: +${perHour.toFixed(1)}% per hour this session${eta !== undefined ? ` · full in ${fmtDur(eta)}` : ''}`,
              dim: true,
            }),
          ]
        })

  const costDetails = () => [
    line({ text: `session ${fmtUsd(s.costUsd)} · pace ${burn === undefined ? '—' : `${fmtUsd(burn)}/h`} · cache hits ${cache === undefined ? '—' : `${cache}%`}`, dim: true }),
    line({ text: `cache served ${fmtTokens(s.cacheRead)} of ${fmtTokens(s.inputTotal)} input tokens`, dim: true }),
    s.turns.length ? line({ text: 'last turns', bold: true }) : null,
    ...s.turns
      .slice(-6)
      .reverse()
      .map(t =>
        line(
          { text: pad(fmtUsd(t.costUsd), 8) },
          { text: `${pad(fmtDur(t.durationMs), 7)}${pad(`${fmtTokens(t.tokensIn)} in`, 10)}cache ${t.tokensIn ? Math.round((t.cacheRead / t.tokensIn) * 100) : 0}%`, dim: true },
        ),
      ),
    line({
      text: `budget: ${p.budgetMode}${p.budgetUsd > 0 ? ` · ${fmtUsd(p.budgetUsd)}` : ' · not set'}${isSubscription(s) ? ' · subscription detected' : ' · API billing'}`,
      dim: true,
    }),
    Object.keys(s.models ?? {}).length ? line({ text: 'by model', bold: true }) : null,
    ...Object.entries(s.models ?? {})
      .sort((a, b) => b[1].tokensIn - a[1].tokensIn)
      .map(([model, m]) =>
        line(
          { text: pad(shortModel(model), nameWidth) },
          { text: `${pad(`${fmtTokens(m.tokensIn)} in`, 10)}${pad(`${fmtTokens(m.tokensOut)} out`, 10)}${m.turns} runs · cache ${m.tokensIn ? Math.round((m.cacheRead / m.tokensIn) * 100) : 0}%`, dim: true },
        ),
      ),
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{`cache lifetime assumed: ${p.cacheTtlMin} min`}</Text>
      <Button
        key="cache-ttl"
        plain
        dimColor
        label={p.cacheTtlMin === 60 ? 'use 5 min' : 'use 1 hour'}
        onPress={() => update($, prefs, cur => ({ ...cur, cacheTtlMin: cur.cacheTtlMin === 60 ? 5 : 60 }))}
      />
    </Box>,
    line({ text: `all-time spend ${fmtUsd(s.lifetimeUsd)}`, dim: true }),
  ]

  const turnDetails = () => {
    const log = (s.turnLog ?? []).slice(-10)
    return log.length === 0
      ? [line({ text: 'no tool calls in this turn yet', dim: true })]
      : [
          line({ text: s.turnActive ? 'this turn, latest last' : 'last turn, latest last', dim: true }),
          ...log.map(entry =>
            line(
              { text: entry.isError ? '✗ ' : '✓ ', color: entry.isError ? 'red' : 'green' },
              { text: entry.agentId ? '↳ ' : '', color: 'magenta' },
              { text: pad(entry.tool.replace(/^mcp__[^_]+__/, ''), 12), bold: true },
              { text: pad(fmtDur(entry.ms), 6), dim: true },
              { text: shorten(entry.label, Math.max(10, cols - labelWidth - 26)), dim: true },
            ),
          ),
        ]
  }

  const toolsDetails = () => [
    line({ text: `${pad('  tool', 16)}${pad('calls', 7)}${pad('errors', 8)}${pad('avg', 7)}max`, dim: true, bold: true }),
    ...Object.entries(s.tools)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 12)
      .map(([name, t]) => {
        const timing = s.toolMs?.[name]
        const isToolOpen = p.toolOpen.includes(name)
        const calls = (s.callLog ?? []).filter(c => c.tool === name).slice(-8).reverse()
        const okShare = t.calls ? Math.round(((t.calls - t.errors) / t.calls) * 100) : 100
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button
                key={`tool-${name}`}
                plain
                dimColor={!isToolOpen}
                label={pad(`${isToolOpen ? '▾' : '▸'} ${name.replace(/^mcp__[^_]+__/, '')}`, 16)}
                onPress={() =>
                  update($, prefs, cur => ({
                    ...cur,
                    toolOpen: cur.toolOpen.includes(name) ? cur.toolOpen.filter(x => x !== name) : [...cur.toolOpen, name].slice(-8),
                  }))
                }
              />
              {line(
                { text: pad(String(t.calls), 7) },
                { text: pad(String(t.errors), 8), color: t.errors ? 'red' : undefined, dim: !t.errors },
                { text: `${pad(timing ? fmtDur(timing.totalMs / Math.max(1, t.calls)) : '—', 7)}${timing ? fmtDur(timing.maxMs) : '—'}`, dim: true },
              )}
            </Box>
            {isToolOpen ? (
              <Box flexDirection="column" paddingLeft={2}>
                {line(
                  { text: `${okShare}% ok`, color: okShare >= 90 ? 'green' : okShare >= 70 ? 'yellow' : 'red' },
                  { text: ` · total ${fmtDur(timing?.totalMs ?? 0)} · last ${calls.length} calls, newest first`, dim: true },
                )}
                {calls.map(c => [
                  line(
                    { text: c.isError ? '✗ ' : '✓ ', color: c.isError ? 'red' : 'green' },
                    { text: pad(fmtAgo(now - c.at), 10), dim: true },
                    { text: pad(fmtDur(c.ms), 6) },
                    { text: c.agentId ? '↳ ' : '', color: 'magenta' },
                    { text: shorten(c.label || '(no input)', Math.max(10, cols - labelWidth - 30)), dim: true },
                  ),
                  c.isError && c.errorText ? line({ text: `    ${shorten(c.errorText, Math.max(10, cols - labelWidth - 8))}`, color: 'red' }) : null,
                ])}
              </Box>
            ) : null}
          </Box>
        )
      }),
  ]

  const toolsDetailsWithHogs = () => [
    ...toolsDetails(),
    line({ text: 'biggest outputs (context hogs)', bold: true }),
    ...((s.topOutputs ?? []).length ? hogLines(8) : [line({ text: 'no tool output over ~500 tokens yet', dim: true })]),
  ]

  const filesDetails = () => {
    const edited = Object.entries(s.edits).sort((a, b) => b[1] - a[1])
    return [
      ...(s.diff.length
        ? s.diff.slice(0, 20).map(f => {
            const isViewed = s.fileView?.path === f.path
            const width = Math.max(12, cols - labelWidth - 20)
            return (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Button
                    key={`file-${f.path}`}
                    plain
                    dimColor={!isViewed}
                    label={pad(`${isViewed ? '▾' : '▸'} ${shorten(f.path, width - 3)}`, width)}
                    onPress={() => (isViewed ? update($, stats, cur => ({ ...cur, fileView: null })) : loadFileView($, f.path, f.add < 0))}
                  />
                  {f.add < 0 ? <Text color="cyan">new</Text> : <Text color="green">{`+${f.add}`}</Text>}
                  {f.add < 0 ? null : <Text color="red">{` −${f.del}`}</Text>}
                </Box>
                {isViewed && s.fileView ? (
                  <Box flexDirection="column" paddingLeft={2}>
                    {s.fileView.lines.map(l =>
                      line({
                        text: shorten(l || ' ', Math.max(10, cols - labelWidth - 8)),
                        color: l.startsWith('@@') ? 'cyan' : l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined,
                        dim: !(l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')),
                      }),
                    )}
                  </Box>
                ) : null}
              </Box>
            )
          })
        : [line({ text: 'no uncommitted changes vs HEAD (or not a git repository)', dim: true })]),
      edited.length ? line({ text: 'edited by Claude this session', bold: true }) : null,
      ...edited.slice(0, 10).map(([path, n]) => line({ text: shorten(relPath(path, s.cwd), Math.max(12, cols - labelWidth - 14)) }, { text: `  ${n}×`, dim: true })),
    ]
  }

  const testsDetails = () =>
    (s.testHistory ?? []).length === 0
      ? [line({ text: 'Runs of npm/pnpm/yarn test, jest, vitest, pytest, go test, cargo test… show up here.', dim: true })]
      : (s.testHistory ?? [])
          .slice()
          .reverse()
          .map(t =>
            line(
              { text: t.isOk ? '✓ ' : '✗ ', color: t.isOk ? 'green' : 'red' },
              { text: pad(fmtAgo(now - t.at), 10), dim: true },
              { text: `${t.passed !== undefined ? `${t.passed} passed ` : ''}${t.failed ? `${t.failed} failed ` : ''}`, color: t.failed ? 'red' : undefined },
              { text: t.command, dim: true },
            ),
          )

  const guardDetails = () => [
    ...(s.guardLog.length === 0
      ? [line({ text: 'nothing stopped yet', dim: true })]
      : s.guardLog
          .slice()
          .reverse()
          .map(g =>
            line(
              { text: g.verdict === 'blocked' ? '✗ blocked ' : '✓ allowed ', color: g.verdict === 'blocked' ? 'red' : 'yellow' },
              { text: pad(fmtAgo(now - g.at), 10), dim: true },
              { text: `${g.reason}: `, dim: true },
              { text: shorten(g.command, Math.max(10, cols - labelWidth - 40)) },
            ),
          )),
    line({ text: 'watches: rm -rf · force push · reset --hard · clean -f · checkout -- . · sudo · curl|sh · DROP TABLE · kubectl delete · terraform destroy · npm publish · .env and key files', dim: true }),
  ]

  const alertsDetails = () => [
    ...(s.loopLog ?? []).slice().reverse().map(l => line({ text: '⟳ ', color: 'yellow' }, { text: pad(fmtAgo(now - l.at), 10), dim: true }, { text: shorten(l.text, Math.max(10, cols - labelWidth - 16)) })),
    ...(s.compactLog ?? []).slice().reverse().map(c => line({ text: '⇣ ', color: 'cyan' }, { text: pad(fmtAgo(now - c.at), 10), dim: true }, { text: `compacted ${fmtTokens(c.before)} → ${fmtTokens(c.after)} (${c.trigger})` })),
    (s.loopLog ?? []).length + (s.compactLog ?? []).length === 0 ? line({ text: 'A loop alert fires when the same call repeats 3 times within 8 calls.', dim: true }) : null,
  ]

  const historyDetails = () => [
    line({ text: `${pad('#', 4)}${pad('time', 7)}${pad('steps', 7)}${pad('tools', 7)}${pad('in', 7)}${pad('out', 7)}${p.isCostHidden ? '' : pad('cost', 8)}end`, dim: true, bold: true }),
    ...s.turns
      .slice(-10)
      .map((t, i, list) =>
        line({
          text: `${pad(String(s.turns.length - list.length + i + 1), 4)}${pad(fmtDur(t.durationMs), 7)}${pad(String(t.steps), 7)}${pad(String(t.tools), 7)}${pad(fmtTokens(t.tokensIn), 7)}${pad(fmtTokens(t.tokensOut), 7)}${p.isCostHidden ? '' : pad(fmtUsd(t.costUsd), 8)}${t.reason}`,
        }),
      ),
  ]

  const lifetimeDetails = () => [
    line({ text: `per session: ${s.lifetimeSessions ? (s.lifetimeTurns / s.lifetimeSessions).toFixed(1) : '—'} turns · ${p.isCostHidden ? '' : `${fmtUsd(s.lifetimeSessions ? s.lifetimeUsd / s.lifetimeSessions : 0)} · `}${s.lifetimeTurns ? (s.lifetimeTools / s.lifetimeTurns).toFixed(1) : '—'} tools per turn`, dim: true }),
    line({ text: 'kept on this machine in the plugin store; Reset clears this session only', dim: true }),
  ]

  const lifetimeBody = line({
    text: `${s.lifetimeSessions} sessions · ${s.lifetimeTurns} turns · ${s.lifetimeTools} tools · ${fmtUsd(s.lifetimeUsd)}`,
    dim: true,
  })

  return (
    <Box flexDirection="column">
      {header}
      {row('CONTEXT', contextBody, contextDetails)}
      {row('LIMITS', limitsBody, limitsDetails)}
      {p.isCostHidden ? null : row('COST', costBody, costDetails)}
      {row('TURN', turnBody, turnDetails)}
      {row('AGENTS', agentsBody, undefined, () => update($, prefs, cur => ({ ...cur, isAgentsOpen: !cur.isAgentsOpen })), p.isAgentsOpen)}
      {row('TOOLS', toolsBody, toolsDetailsWithHogs)}
      {row('FILES', fileRows, filesDetails)}
      {row('TESTS', testBody, testsDetails)}
      {row('GUARD', guardBody, guardDetails)}
      {row('ALERTS', alertsBody, alertsDetails)}
      {row('HISTORY', historyBody, historyDetails)}
      {row('ALL-TIME', lifetimeBody, lifetimeDetails)}
      {controls}
    </Box>
  )
}

const addModel = (
  models: CockpitStats['models'],
  u: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
) => {
  const cur = models[u.model] ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, turns: 0 }
  return {
    ...models,
    [u.model]: {
      tokensIn: cur.tokensIn + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      tokensOut: cur.tokensOut + u.output_tokens,
      cacheRead: cur.cacheRead + u.cache_read_input_tokens,
      turns: cur.turns + 1,
    },
  }
}

const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

// How long the prompt cache stays warm after the last response, as this session sees it.
const cacheLeftMs = (s: CockpitStats, p: CockpitPrefs, now: number) =>
  s.lastResponseAt ? s.lastResponseAt + p.cacheTtlMin * 60_000 - now : undefined

const loadFileView = async ($: Dollar, path: string, isNew: boolean) => {
  const now = await $.clock.now()
  let lines: string[] = []
  if (SECRET_FILE.test(path)) {
    await update($, stats, s => ({ ...s, fileView: { path, lines: ['(secrets file: contents not read)'], at: now } }))
    return
  }
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    const root = top.exitCode === 0 ? top.stdout.trim() : undefined
    if (isNew) {
      const text = await $.fs.read(root ? `${root}/${path}` : path)
      lines = (typeof text === 'string' ? text : '').split('\n').slice(0, 40).map(l => `+${l}`)
      lines.unshift('@@ new file @@')
    } else {
      let run = await $.process.run(['git', 'diff', '--unified=1', '--no-color', 'HEAD', '--', path], { cwd: root, timeoutMs: 5000 })
      if (run.exitCode !== 0) run = await $.process.run(['git', 'diff', '--unified=1', '--no-color', '--', path], { cwd: root, timeoutMs: 5000 })
      lines = run.stdout
        .split('\n')
        .filter(l => !l.startsWith('diff --git') && !l.startsWith('index ') && !l.startsWith('--- ') && !l.startsWith('+++ '))
        .slice(0, 60)
    }
  } catch (error) {
    lines = [`could not read the changes: ${String(error)}`]
  }
  await update($, stats, s => ({ ...s, fileView: { path, lines: lines.length ? lines : ['(no textual changes)'], at: now } }))
}

// Realistic sample numbers, so people can see the panel before a long session.
const demoStats = (cur: CockpitStats, now: number): CockpitStats => {
  const min = 60_000
  const agentA = 'demo-agent-a'
  const agentB = 'demo-agent-b'
  return {
    ...cur,
    startedAt: now - 47 * min,
    model: 'claude-opus-5-5',
    cwd: '/Users/you/acme-web',
    ctxTokens: 131_000,
    ctxWindow: 200_000,
    ctxPercent: 66,
    ctxParts: [
      { name: 'Messages', tokens: 98_400 },
      { name: 'System prompt', tokens: 14_200 },
      { name: 'System tools', tokens: 11_900 },
      { name: 'MCP tools', tokens: 4_100 },
      { name: 'Memory files', tokens: 2_400 },
    ],
    ctxFree: 52_000,
    ctxMemory: [{ path: '/Users/you/acme-web/CLAUDE.md', tokens: 1_900 }, { path: '/Users/you/.claude/CLAUDE.md', tokens: 500 }],
    ctxMcp: [{ server: 'github', tokens: 2_900, tools: 14 }, { server: 'linear', tokens: 1_200, tools: 6 }],
    limits: [
      { kind: 'five_hour', percentUsed: 58, resetsAt: new Date(now + 96 * min).toISOString() },
      { kind: 'seven_day', percentUsed: 23, resetsAt: new Date(now + 3 * 24 * 60 * min).toISOString() },
    ],
    limitStart: { five_hour: { pct: 31, at: now - 45 * min }, seven_day: { pct: 21, at: now - 45 * min } },
    costUsd: 4.86,
    turnActive: true,
    turnStartedAt: now - 83_000,
    turnSteps: 7,
    turnTools: 11,
    turnCostAtStart: 4.41,
    tools: {
      Read: { calls: 41, errors: 0 },
      Bash: { calls: 23, errors: 3 },
      Edit: { calls: 17, errors: 1 },
      Grep: { calls: 12, errors: 0 },
      Agent: { calls: 2, errors: 0 },
      WebFetch: { calls: 2, errors: 1 },
    },
    toolTotal: 97,
    toolErrors: 5,
    toolMs: {
      Read: { totalMs: 9_000, maxMs: 900 },
      Bash: { totalMs: 212_000, maxMs: 48_000 },
      Edit: { totalMs: 6_000, maxMs: 700 },
      Grep: { totalMs: 4_000, maxMs: 600 },
      Agent: { totalMs: 160_000, maxMs: 95_000 },
      WebFetch: { totalMs: 7_000, maxMs: 5_200 },
    },
    slowest: { tool: 'Bash', ms: 48_000, label: 'npm test' },
    edits: { '/Users/you/acme-web/src/auth/session.ts': 6, '/Users/you/acme-web/src/auth/session.test.ts': 4, '/Users/you/acme-web/src/api/login.ts': 3 },
    diff: [
      { path: 'src/auth/session.ts', add: 84, del: 31 },
      { path: 'src/auth/session.test.ts', add: 57, del: 4 },
      { path: 'src/api/login.ts', add: 12, del: 9 },
      { path: 'src/auth/token-store.ts', add: -1, del: 0 },
    ],
    diffAdd: 153,
    diffDel: 44,
    fileView: null,
    lastTest: { command: 'npm test -- auth', isOk: true, passed: 48, failed: 0, at: now - 2 * min },
    testHistory: [
      { command: 'npm test -- auth', isOk: false, passed: 45, failed: 3, at: now - 14 * min },
      { command: 'npm test -- auth', isOk: false, passed: 47, failed: 1, at: now - 8 * min },
      { command: 'npm test -- auth', isOk: true, passed: 48, failed: 0, at: now - 2 * min },
    ],
    testRuns: 3,
    testFails: 2,
    turns: [
      { durationMs: 41_000, tools: 6, steps: 5, tokensIn: 48_000, tokensOut: 2_100, costUsd: 0.31, cacheRead: 39_000, reason: 'answer' },
      { durationMs: 154_000, tools: 22, steps: 14, tokensIn: 162_000, tokensOut: 9_800, costUsd: 1.42, cacheRead: 141_000, reason: 'answer' },
      { durationMs: 72_000, tools: 9, steps: 8, tokensIn: 98_000, tokensOut: 4_300, costUsd: 0.66, cacheRead: 88_000, reason: 'answer' },
      { durationMs: 209_000, tools: 31, steps: 19, tokensIn: 244_000, tokensOut: 12_600, costUsd: 1.58, cacheRead: 221_000, reason: 'answer' },
      { durationMs: 38_000, tools: 4, steps: 4, tokensIn: 122_000, tokensOut: 1_900, costUsd: 0.44, cacheRead: 117_000, reason: 'answer' },
    ],
    cacheRead: 606_000,
    inputTotal: 674_000,
    lastResponseAt: now - 4_000,
    models: {
      'claude-opus-5-5': { tokensIn: 674_000, tokensOut: 30_700, cacheRead: 606_000, turns: 5 },
      'claude-haiku-4-5-20251001': { tokensIn: 212_000, tokensOut: 8_400, cacheRead: 150_000, turns: 2 },
    },
    topOutputs: [
      { tool: 'Read', label: 'package-lock.json', tokens: 41_000, at: now - 31 * min },
      { tool: 'Bash', label: 'npm test', tokens: 9_400, at: now - 14 * min },
      { tool: 'WebFetch', label: 'https://datatracker.ietf.org/doc/html/rfc6749', tokens: 7_800, agentId: agentB, at: now - 22 * min },
      { tool: 'Grep', label: 'sessionToken', tokens: 2_100, at: now - 26 * min },
    ],
    callLog: [
      { tool: 'Grep', label: 'refreshToken', ms: 400, isError: false, agentId: agentA, at: now - 9 * min },
      { tool: 'Read', label: 'src/auth/session.ts', ms: 200, isError: false, agentId: agentA, at: now - 9 * min },
      { tool: 'Read', label: 'src/api/login.ts', ms: 200, isError: false, agentId: agentA, at: now - 8 * min },
      { tool: 'Bash', label: 'npm test -- auth', ms: 44_000, isError: true, errorText: 'FAIL src/auth/session.test.ts: expected token to rotate after 15m', at: now - 8 * min },
      { tool: 'Edit', label: 'src/auth/session.ts', ms: 300, isError: false, at: now - 6 * min },
      { tool: 'Bash', label: 'npm run lint', ms: 6_100, isError: false, at: now - 4 * min },
      { tool: 'Bash', label: 'npm test -- auth', ms: 48_000, isError: false, at: now - 2 * min },
      { tool: 'Bash', label: 'git diff --stat', ms: 300, isError: false, at: now - 1 * min },
    ],
    turnLog: [
      { tool: 'Read', label: 'src/auth/token-store.ts', ms: 200, isError: false, at: now - 80_000 },
      { tool: 'Edit', label: 'src/auth/session.ts', ms: 300, isError: false, at: now - 70_000 },
      { tool: 'Bash', label: 'npm test -- auth', ms: 48_000, isError: false, at: now - 62_000 },
      { tool: 'Bash', label: 'git diff --stat', ms: 300, isError: false, at: now - 9_000 },
    ],
    agents: {
      [agentA]: {
        id: agentA, type: 'Explore', description: 'Map every place that reads the session token', status: 'completed',
        startedAt: now - 10 * min, endedAt: now - 7 * min, steps: 9, tools: 14, errors: 0,
        toolCounts: { Grep: 6, Read: 7, Glob: 1 }, lastTool: 'Read src/api/login.ts', tokensIn: 142_000, tokensOut: 5_200,
        result: 'Found 6 readers: session.ts (3), login.ts, middleware/auth.ts, ws/handshake.ts. Only session.ts rotates the token.',
      },
      [agentB]: {
        id: agentB, type: 'general-purpose', description: 'Check RFC 6749 refresh-token rotation rules', status: 'running',
        startedAt: now - 3 * min, steps: 4, tools: 3, errors: 1,
        toolCounts: { WebFetch: 2, Read: 1 }, lastTool: 'WebFetch https://datatracker.ietf.org/doc/html/rfc6749', tokensIn: 70_000, tokensOut: 3_200,
      },
    },
    agentsActive: [agentB],
    agentsSpawned: 2,
    guardBlocked: 1,
    guardAllowed: 1,
    secretsBlocked: 1,
    guardLog: [
      { command: 'git push --force origin main', reason: 'force push rewrites remote history', verdict: 'blocked', at: now - 19 * min },
      { command: 'Write .env.local', reason: 'secrets file', verdict: 'blocked', at: now - 12 * min },
      { command: 'rm -rf node_modules', reason: 'recursive force delete', verdict: 'allowed', at: now - 5 * min },
    ],
    loopAlerts: 1,
    lastLoop: 'Bash ×3: npm test -- auth',
    loopLog: [{ text: 'Bash ×3: npm test -- auth', at: now - 11 * min }],
    compactions: 1,
    lastCompact: { before: 184_000, after: 41_000, trigger: 'auto' },
    compactLog: [{ before: 184_000, after: 41_000, trigger: 'auto', at: now - 33 * min }],
    lifetimeSessions: 38,
    lifetimeTurns: 412,
    lifetimeTools: 5_120,
    lifetimeUsd: 96.4,
  }
}

// ---------- the module ----------

let isInteractive = true
let ticker: Timer | undefined
let idleTicker: Timer | undefined

// Redraws every few seconds so the cache countdown stays current between turns.
const startIdleTicker = ($: Dollar) => {
  idleTicker?.cancel()
  idleTicker = $.clock.every(5000, () => $.ui.invalidate('ui.render'))
}

const startTicker = ($: Dollar) => {
  ticker?.cancel()
  ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
}

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
}

const openPane = async ($: Dollar) => {
  const opened = await $.ui.open({ id: PANE, title: 'Cockpit', rows: 26 })
  const reason = opened.isPlaced ? '' : opened.reason
  const before = await read($, pane)
  await update($, pane, () => ({ isPlaced: opened.isPlaced, reason }))
  if (!opened.isPlaced && before.reason !== reason) {
    $.ui.log(`cockpit: the panel is not shown here (${reason}). The Cockpit band above the prompt and /cockpit-report show the same data.`)
  }
  return opened
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive

    await $.command.register({ name: 'cockpit', description: 'Open the agent cockpit panel' })
    await $.command.register({ name: 'cockpit-report', description: 'Print a cockpit summary of this session' })
    await $.command.register({ name: 'cockpit-guard', description: 'Turn the risky-command guard on or off', argumentHint: '[on|off]' })
    await $.command.register({ name: 'cockpit-budget', description: 'Set a spend budget for this session, in USD', argumentHint: '[amount|off]' })
    await $.command.register({ name: 'cockpit-export', description: 'Save a Markdown report of this session to .cockpit/' })
    await $.command.register({ name: 'cockpit-demo', description: 'Fill the cockpit with sample data to see every section (off restores yours)', argumentHint: '[off]' })
    await $.command.register({ name: 'cockpit-cache', description: 'Set the prompt-cache lifetime the countdown assumes', argumentHint: '[5|60]' })

    // fill in fields added by newer versions of the mod
    await update($, stats, s => ({ ...EMPTY_STATS, ...s }))
    await update($, prefs, p => ({ ...DEFAULT_PREFS, ...p }))

    const current = await read($, stats)
    if (current.startedAt === 0) {
      const usage = await $.session.usage()
      const lifetime = ((await $.store.get(STORE_LIFETIME)) ?? {}) as { turns?: number; tools?: number; usd?: number; sessions?: number }
      const sessions = (lifetime.sessions ?? 0) + 1
      await $.store.set(STORE_LIFETIME, { ...lifetime, sessions })
      await update($, stats, s => ({
        ...s,
        startedAt: usage.startedAt,
        cwd: e.cwd,
        lifetimeTurns: lifetime.turns ?? 0,
        lifetimeTools: lifetime.tools ?? 0,
        lifetimeUsd: lifetime.usd ?? 0,
        lifetimeSessions: sessions,
      }))
    }
    if (current.turnActive) startTicker($)
    startIdleTicker($)

    await refreshUsage($)
    await refreshDiff($)
    await refreshBreakdown($)

    if (e.isInteractive) {
      await openPane($)
    }
    return started
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await applyUsage($, e)
    return measured
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const now = await $.clock.now()
    await update($, stats, s => ({
      ...s,
      turnActive: true,
      turnStartedAt: now,
      turnSteps: 0,
      turnTools: 0,
      turnCostAtStart: s.costUsd,
      turnLog: [],
    }))
    startTicker($)
    await pushStatus($)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) await update($, stats, s => ({ ...s, turnSteps: s.turnSteps + 1 }))
    else {
      const now = await $.clock.now()
      const known = (await read($, stats)).agents?.[agentId]
      await update($, stats, s => {
        const cur = s.agents?.[agentId] ?? newAgent(agentId, now)
        const isNew = !s.agentsActive.includes(agentId)
        return {
          ...s,
          agentsActive: isNew ? [...s.agentsActive, agentId] : s.agentsActive,
          agentsSpawned: s.agentsSpawned + (s.agents?.[agentId] ? 0 : 1),
          agents: { ...s.agents, [agentId]: { ...cur, steps: cur.steps + 1, status: 'running' } },
        }
      })
      if (!known) await refreshAgents($)
    }
    const result = yield* next(e)
    if (!agentId) {
      const done = await $.clock.now()
      await update($, stats, s => ({ ...s, lastResponseAt: done }))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const tool = e.tool
    const command = tool === 'Bash' && typeof args.command === 'string' ? args.command : undefined

    if (command !== undefined) {
      const p = await read($, prefs)
      const reason = p.isGuardOn ? checkRisk(command) : undefined
      if (reason !== undefined && isInteractive) {
        let answer = 'Block it'
        try {
          answer = await $.ui.ask(`Cockpit guard: this command ${reason}. Run it anyway?`, {
            header: 'Guard',
            options: ['Run it', 'Block it'],
          })
        } catch {
          answer = 'Block it'
        }
        const verdict: 'allowed' | 'blocked' = answer === 'Run it' ? 'allowed' : 'blocked'
        const now = await $.clock.now()
        await update($, stats, s => ({
          ...s,
          guardBlocked: s.guardBlocked + (verdict === 'blocked' ? 1 : 0),
          guardAllowed: s.guardAllowed + (verdict === 'allowed' ? 1 : 0),
          guardLog: [...s.guardLog, { command: shorten(command, 120), reason, verdict, at: now }].slice(-10),
        }))
        if (verdict === 'blocked') {
          return { deny: `Blocked by the Cockpit guard (${reason}). Ask the user before retrying a command like this.` }
        }
      }
    }

    const filePath = EDIT_TOOLS.has(tool)
      ? typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.notebook_path === 'string'
          ? args.notebook_path
          : undefined
      : undefined

    if (filePath && SECRET_FILE.test(filePath)) {
      const p = await read($, prefs)
      if (p.isGuardOn && isInteractive) {
        let answer = 'Block it'
        try {
          answer = await $.ui.ask(`Cockpit guard: Claude wants to change a secrets file (${filePath.split('/').at(-1)}). Allow it?`, {
            header: 'Secrets',
            options: ['Allow', 'Block it'],
          })
        } catch {
          answer = 'Block it'
        }
        const now = await $.clock.now()
        const isAllowed = answer === 'Allow'
        await update($, stats, s => ({
          ...s,
          secretsBlocked: s.secretsBlocked + (isAllowed ? 0 : 1),
          guardLog: [...s.guardLog, { command: `${tool} ${shorten(filePath, 100)}`, reason: 'secrets file', verdict: isAllowed ? 'allowed' as const : 'blocked' as const, at: now }].slice(-10),
        }))
        if (!isAllowed) return { deny: 'Blocked by the Cockpit guard: this is a secrets file. Ask the user to edit it themselves.' }
      }
    }

    // loop detector: the same call over and over within a short window
    const signature = signatureOf(tool, args)
    const before = await read($, stats)
    const recent = [...(before.recentSigs ?? []), signature].slice(-LOOP_WINDOW)
    const repeats = recent.filter(sig => sig === signature).length
    const isLoop = repeats >= LOOP_REPEATS && !(before.loopSigs ?? []).includes(signature)
    if (isLoop) {
      const label = shorten(signature.replace(/^[^:]+:/, '') || tool, 60)
      $.ui.toast(`Cockpit: possible loop, ${tool} ran ${repeats}× with the same input (${label})`, { timeoutMs: 8000 })
    }

    const startedAt = await $.clock.now()
    await update($, stats, s => {
      const t = s.tools[tool] ?? { calls: 0, errors: 0 }
      return {
        ...s,
        tools: { ...s.tools, [tool]: { calls: t.calls + 1, errors: t.errors } },
        toolTotal: s.toolTotal + 1,
        turnTools: s.turnTools + (e.agentId ? 0 : 1),
        edits: filePath ? { ...s.edits, [filePath]: (s.edits[filePath] ?? 0) + 1 } : s.edits,
        agents: e.agentId
          ? (() => {
              const id = e.agentId
              const cur = s.agents?.[id] ?? newAgent(id, startedAt)
              return {
                ...s.agents,
                [id]: {
                  ...cur,
                  tools: cur.tools + 1,
                  toolCounts: { ...cur.toolCounts, [tool]: (cur.toolCounts[tool] ?? 0) + 1 },
                  lastTool: `${tool}${signature.replace(/^[^:]+/, '') ? ` ${shorten(signature.replace(/^[^:]+:/, ''), 50)}` : ''}`,
                },
              }
            })()
          : s.agents,
        recentSigs: recent,
        loopSigs: isLoop ? [...s.loopSigs, signature].slice(-20) : s.loopSigs,
        loopAlerts: s.loopAlerts + (isLoop ? 1 : 0),
        lastLoop: isLoop ? `${tool} ×${repeats}: ${shorten(signature.replace(/^[^:]+:/, ''), 80)}` : s.lastLoop,
        loopLog: isLoop ? [...(s.loopLog ?? []), { text: `${tool} ×${repeats}: ${shorten(signature.replace(/^[^:]+:/, ''), 80)}`, at: startedAt }].slice(-6) : s.loopLog,
      }
    })

    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true
    const tookMs = (await $.clock.now()) - startedAt
    const outTokens = Math.round((ran.text ?? '').length / 4)
    if (outTokens >= 500) {
      await update($, stats, s => ({
        ...s,
        topOutputs: [...(s.topOutputs ?? []), { tool, label: shorten(signature.replace(/^[^:]+:/, ''), 80), tokens: outTokens, agentId: e.agentId, at: startedAt }]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 8),
      }))
    }
    await update($, stats, s => {
      const timing = s.toolMs[tool] ?? { totalMs: 0, maxMs: 0 }
      const isSlowest = !s.slowest || tookMs > s.slowest.ms
      return {
        ...s,
        toolMs: { ...s.toolMs, [tool]: { totalMs: timing.totalMs + tookMs, maxMs: Math.max(timing.maxMs, tookMs) } },
        slowest: isSlowest ? { tool, ms: tookMs, label: shorten(signature.replace(/^[^:]+:/, '') || tool, 60) } : s.slowest,
        callLog: [
          ...(s.callLog ?? []),
          {
            tool,
            label: shorten(signature.replace(/^[^:]+:/, ''), 90),
            ms: tookMs,
            isError,
            errorText: isError ? shorten((ran.deny ?? ran.text ?? '').replace(/\s+/g, ' ').trim(), 160) : undefined,
            agentId: e.agentId,
            at: startedAt,
          } as CockpitCall,
        ].slice(-120),
        turnLog: [
          ...(s.turnLog ?? []),
          { tool, label: shorten(signature.replace(/^[^:]+:/, ''), 70), ms: tookMs, isError, agentId: e.agentId, at: startedAt },
        ].slice(-20),
      }
    })

    if (isError) {
      await update($, stats, s => {
        const t = s.tools[tool] ?? { calls: 1, errors: 0 }
        const agentId = e.agentId
        const agent = agentId ? s.agents?.[agentId] : undefined
        return {
          ...s,
          tools: { ...s.tools, [tool]: { calls: t.calls, errors: t.errors + 1 } },
          toolErrors: s.toolErrors + 1,
          agents: agentId && agent ? { ...s.agents, [agentId]: { ...agent, errors: agent.errors + 1 } } : s.agents,
        }
      })
    }

    if (command !== undefined && TEST_COMMAND.test(command) && ran.deny === undefined) {
      const parsed = parseTestOutput(ran.text ?? '')
      const isOk = !isError && (parsed.failed ?? 0) === 0
      const test: CockpitTest = { command: shorten(command, 60), isOk, passed: parsed.passed, failed: parsed.failed, at: await $.clock.now() }
      await update($, stats, s => ({
        ...s,
        lastTest: test,
        testRuns: s.testRuns + 1,
        testFails: s.testFails + (isOk ? 0 : 1),
        testHistory: [...(s.testHistory ?? []), test].slice(-6),
      }))
    }

    if (filePath) await refreshDiff($)
    await pushStatus($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId
    if (agentId) {
      const now = await $.clock.now()
      const u = e.usage
      await update($, stats, s => {
        const cur = s.agents?.[agentId]
        return {
          ...s,
          agentsActive: s.agentsActive.filter(id => id !== agentId),
          models: u ? addModel(s.models ?? {}, u) : s.models,
          agents: cur
            ? {
                ...s.agents,
                [agentId]: {
                  ...cur,
                  status: e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed',
                  endedAt: now,
                  result: e.answer ? shorten(e.answer.replace(/\s+/g, ' ').trim(), 300) : cur.result,
                  tokensIn: cur.tokensIn + (u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0),
                  tokensOut: cur.tokensOut + (u ? u.output_tokens : 0),
                },
              }
            : s.agents,
        }
      })
      await refreshAgents($)
      return done
    }
    stopTicker()

    let cost = (await read($, stats)).costUsd
    try {
      cost = (await $.session.usage()).cost?.usd ?? cost
    } catch {
      // keep the last known cost
    }
    const u = e.usage
    const before = await read($, stats)
    const record: CockpitTurnRecord = {
      durationMs: e.durationMs,
      tools: before.turnTools,
      steps: before.turnSteps,
      tokensIn: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0,
      tokensOut: u ? u.output_tokens : 0,
      costUsd: Math.max(0, cost - before.turnCostAtStart),
      cacheRead: u ? u.cache_read_input_tokens : 0,
      reason: e.reason,
    }
    const after = await update($, stats, s => ({
      ...s,
      turnActive: false,
      agentsActive: [],
      costUsd: cost,
      cacheRead: s.cacheRead + record.cacheRead,
      models: u ? addModel(s.models ?? {}, u) : s.models,
      inputTotal: s.inputTotal + record.tokensIn,
      turns: [...s.turns, record].slice(-12),
      lifetimeTurns: s.lifetimeTurns + 1,
      lifetimeTools: s.lifetimeTools + record.tools,
      lifetimeUsd: s.lifetimeUsd + record.costUsd,
    }))
    const lifetime = ((await $.store.get(STORE_LIFETIME)) ?? {}) as Record<string, unknown>
    await $.store.set(STORE_LIFETIME, {
      ...lifetime,
      turns: after.lifetimeTurns,
      tools: after.lifetimeTools,
      usd: after.lifetimeUsd,
    })

    await refreshDiff($)
    await refreshBreakdown($)
    await warnOnce($)
    await pushStatus($)
    if (e.durationMs > 120_000) {
      $.ui.toast(`Cockpit: that turn took ${fmtDur(e.durationMs)} · ${record.tools} tools · ${fmtUsd(record.costUsd)}`)
    }
    return done
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && !e.agentId && result.skip === undefined) {
      const now = await $.clock.now()
      const compacted = result as { tokensBefore?: number; tokensAfter?: number }
      await update($, stats, s => ({
        ...s,
        compactions: s.compactions + 1,
        lastCompact: { before: compacted.tokensBefore, after: compacted.tokensAfter, trigger: e.trigger },
        compactLog: [...(s.compactLog ?? []), { before: compacted.tokensBefore, after: compacted.tokensAfter, trigger: e.trigger, at: now }].slice(-5),
        warned: s.warned.filter(id => !id.startsWith('ctx')),
      }))
      $.ui.toast(`Cockpit: context compacted ${fmtTokens(compacted.tokensBefore)} → ${fmtTokens(compacted.tokensAfter)}`)
    }
    return result
  })

  on('command.run', { command: 'cockpit-budget' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/^\$/, '')
    if (arg === 'auto' || arg === 'on' || arg === 'off') {
      const mode: CockpitPrefs['budgetMode'] = arg
      await update($, prefs, cur => ({ ...cur, budgetMode: mode }))
      await pushStatus($)
      return { text: `Cockpit budget display: ${mode}${mode === 'auto' ? ' (shown with API-key billing, hidden on a subscription)' : ''}.` }
    }
    const amount = arg === '' ? 0 : Number(arg)
    if (Number.isNaN(amount) || amount < 0) return { text: 'Usage: /cockpit-budget 5 (USD for this session) · /cockpit-budget on | off | auto' }
    await update($, prefs, cur => ({ ...cur, budgetUsd: amount, budgetMode: amount > 0 ? 'on' : cur.budgetMode }))
    await update($, stats, s => ({ ...s, warned: s.warned.filter(id => !id.startsWith('budget')) }))
    await warnOnce($)
    await pushStatus($)
    return { text: amount > 0 ? `Cockpit budget set to ${fmtUsd(amount)} for this session.` : 'Cockpit budget is off.' }
  })
    .catch(($, e, next) => ({ text: `Cockpit: /cockpit-budget failed: ${String(next.error)}` }))

  on('command.run', { command: 'cockpit-demo' }, async ($, e) => {
    const now = await $.clock.now()
    if (e.args.trim() === 'off') {
      const saved = (await $.store.get('demo-backup')) as CockpitStats | undefined
      if (!saved) return { text: 'Cockpit is not in demo mode.' }
      stopTicker()
      await update($, stats, () => ({ ...EMPTY_STATS, ...saved }))
      await $.store.delete('demo-backup')
      await pushStatus($)
      return { text: 'Cockpit demo off: your session data is back.' }
    }
    const cur = await read($, stats)
    if (!(await $.store.get('demo-backup'))) await $.store.set('demo-backup', cur)
    await update($, stats, s => demoStats(s, now))
    await pushStatus($)
    return { text: 'Cockpit demo on: sample data in every section. /cockpit-demo off restores your session.' }
  })
    .catch(($, e, next) => ({ text: `Cockpit: /cockpit-demo failed: ${String(next.error)}` }))

  on('command.run', { command: 'cockpit-cache' }, async ($, e) => {
    const minutes = Number(e.args.trim().replace(/m$/, ''))
    if (!(minutes > 0 && minutes <= 120)) return { text: 'Usage: /cockpit-cache 5 (default API cache) or /cockpit-cache 60 (1-hour cache)' }
    await update($, prefs, cur => ({ ...cur, cacheTtlMin: minutes }))
    return { text: `Cockpit assumes a ${minutes}-minute prompt cache.` }
  })
    .catch(($, e, next) => ({ text: `Cockpit: /cockpit-cache failed: ${String(next.error)}` }))

  on('command.run', { command: 'cockpit-export' }, async $ => ({ text: await exportReport($) }))
    .catch(($, e, next) => ({ text: `Cockpit export failed: ${String(next.error)}` }))

  on('command.run', { command: 'cockpit' }, async $ => {
    const opened = await openPane($)
    if (opened.isPlaced) return { text: 'Cockpit panel opened.' }
    const s = await read($, stats)
    return { text: `${buildReport(s, await $.clock.now())}\n\n(The side panel is not available here: ${opened.reason}. The Cockpit band above the prompt stays live.)` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, pane, cur => ({ ...cur, isPlaced: false }))
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, prefs)
    const where = await read($, pane)
    if (e.props.hasSurvey || (where.isPlaced && !p.isBandOn)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, stats)
    const now = await $.clock.now()
    const width = Math.max(6, Math.min(16, e.props.bodyColumns - 60))
    const pct = s.ctxPercent
    const fiveHour = s.limits.find(l => l.kind === 'five_hour')
    const sevenDay = s.limits.find(l => l.kind === 'seven_day')
    const lastTurn = s.turns.at(-1)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text bold color="cyan">◆ Cockpit</Text>
          <Text dimColor>ctx</Text>
          {pct === undefined ? <Text dimColor>—</Text> : <Text color={levelColor(pct)}>{bar(pct, width)} {pct}%</Text>}
          {fiveHour ? <Text color={levelColor(fiveHour.percentUsed)}>5h {Math.round(fiveHour.percentUsed)}%</Text> : null}
          {sevenDay ? <Text color={levelColor(sevenDay.percentUsed)}>7d {Math.round(sevenDay.percentUsed)}%</Text> : null}
          {p.isCostHidden ? null : <Text bold>{isBudgetVisible(p, s) ? `${fmtUsd(s.costUsd)}/${fmtUsd(p.budgetUsd)}` : fmtUsd(s.costUsd)}</Text>}
          {s.loopAlerts ? <Text color="yellow">{`⟳ ${s.loopAlerts}`}</Text> : null}
          {visibleAgents(s).some(a => a.status === 'running') ? <Text color="magenta">{`${visibleAgents(s).filter(a => a.status === 'running').length} agent${visibleAgents(s).filter(a => a.status === 'running').length > 1 ? 's' : ''}`}</Text> : null}
          <Text dimColor>{`${s.toolTotal} tools${s.toolErrors ? `, ${s.toolErrors} err` : ''}`}</Text>
          {s.turnActive ? (
            <Text color="cyan">{`● ${fmtDur(now - s.turnStartedAt)} · ${s.turnSteps} steps · ${s.turnTools} tools`}</Text>
          ) : lastTurn ? (
            <Text dimColor>{`○ last ${fmtDur(lastTurn.durationMs)}`}</Text>
          ) : null}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>{`files ${s.diff.length || Object.keys(s.edits).length}${s.diff.length ? ` (+${s.diffAdd} −${s.diffDel})` : ''}`}</Text>
          {s.lastTest ? <Text color={s.lastTest.isOk ? 'green' : 'red'}>{s.lastTest.isOk ? '✓ tests' : '✗ tests'}</Text> : null}
          <Text color={p.isGuardOn ? 'green' : 'yellow'}>{`guard ${p.isGuardOn ? 'on' : 'off'}${s.guardBlocked ? ` · ${s.guardBlocked} blocked` : ''}`}</Text>
          {(() => {
            const left = cacheLeftMs(s, p, now)
            if (left === undefined || s.turnActive) return null
            return left > 0 ? <Text color={left > 60_000 ? 'green' : 'yellow'}>{`cache ${fmtDur(left)}`}</Text> : <Text color="yellow">cache cold</Text>
          })()}
          {(s.ctxPercent ?? 0) >= 70 && !s.turnActive ? <Button key="band-compact" variant="primary" label="Compact now" onPress={() => $.command.run({ command: 'compact' })} /> : null}
          <Button key="band-open" label="Panel" dimColor onPress={() => openPane($)} />
          <Button key="band-report" label="Report" dimColor onPress={async () => { const cur = await read($, stats); $.ui.log(buildReport(cur, await $.clock.now())) }} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'cockpit-report' }, async $ => {
    const s = await read($, stats)
    return { text: buildReport(s, await $.clock.now()) }
  })
    .catch(($, e, next) => ({ text: `Cockpit: /cockpit-report failed: ${String(next.error)}` }))

  on('command.run', { command: 'cockpit-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const p = await update($, prefs, cur => ({
      ...cur,
      isGuardOn: arg === 'on' ? true : arg === 'off' ? false : !cur.isGuardOn,
    }))
    return { text: `Cockpit guard is ${p.isGuardOn ? 'on' : 'off'}.` }
  })
    .catch(($, e, next) => ({ text: `Cockpit: /cockpit-guard failed: ${String(next.error)}` }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawCockpit($, $.ui.resolve(e), e.props.bodyColumns))
}
