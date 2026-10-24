import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import type { Burn, Edits, Level, Limit, Line, Tokens } from '../types'

const WINDOW_ORDER = ['five_hour', 'seven_day']
const WARM_PERCENT = 80
const HOT_PERCENT = 90

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const CHART_MINUTES = 8
const BARS = '▁▂▃▄▅▆▇█'
// The burn rate is measured over at least this long, so two quick ticks don't read as a spike
const BURN_MIN_SPAN = 5 * MINUTE
const BURN_LOOKBACK = 20 * MINUTE
const REFRESH_EVERY = 30_000

const LEVEL_COLOR: Record<Level, Color> = { calm: 'inactive', warm: 'warning', hot: 'error' }
const LEVEL_EMOJI: Record<Level, string> = { calm: '🧶', warm: '🔥', hot: '🙀' }

const line = atom({ plugin: 'whiskers', key: 'line' } as const, { limits: [] } as Line)

// Pawprints is optional: false once it turns out not to be installed
let hasPawprints = true
let promptStartedAt = 0

// Tokens each model request spent, and the 5 hour window's readings, newest last
let spends: { at: number; tokens: number }[] = []
let readings: { at: number; percent: number }[] = []
let resetsAt: number | undefined

// "claude-opus-5-5" -> "Opus 5.5"; names that are already readable pass through
function shortModel(name: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(name)
  if (!match) return name.replace(/\s*\(.*\)$/, '')
  const [, family = '', major, minor] = match
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

function windowRank(kind: string): number {
  const index = WINDOW_ORDER.indexOf(kind)
  return index === -1 ? WINDOW_ORDER.length : index
}

function percentColor(percent: number): Color {
  if (percent >= HOT_PERCENT) return 'error'
  if (percent >= WARM_PERCENT) return 'warning'
  return 'inactive'
}

function shortNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}

function shortDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

function set($: EngineInterface, change: Partial<Line>): Promise<unknown> {
  return update($, line, current => ({ ...current, ...change }))
}

// Asks pawprints what Claude changed since the current prompt began
async function readEdits($: EngineInterface): Promise<Edits | undefined> {
  if (!hasPawprints || promptStartedAt === 0) return undefined
  const since = new Date(promptStartedAt).toISOString()
  const argv = ['pawprints', 'log', '--json', '--all-events', '--kind', 'edit,background', '--session', await $.session.id(), '--since', since]
  let stdout: string
  try {
    const ran = await $.process.run(argv, { timeoutMs: 5000 })
    if (ran.exitCode !== 0) return undefined
    stdout = ran.stdout
  } catch {
    hasPawprints = false
    return undefined
  }
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  for (const row of stdout.split('\n')) {
    if (!row.trim()) continue
    const event = JSON.parse(row) as { path: string; lines_added?: number; lines_removed?: number }
    paths.add(event.path)
    added += event.lines_added ?? 0
    removed += event.lines_removed ?? 0
  }
  return paths.size > 0 ? { files: paths.size, added, removed } : undefined
}

function toLimits(windows: readonly SessionRateLimit[]): Limit[] {
  return [...windows]
    .sort((a, b) => windowRank(a.kind) - windowRank(b.kind))
    .map(window => ({ kind: window.kind, percent: Math.round(window.percentUsed) }))
}

function recordReading(windows: readonly SessionRateLimit[], now: number): void {
  const window = windows.find(limit => limit.kind === 'five_hour')
  if (!window) return
  resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : undefined
  const last = readings[readings.length - 1]
  // A lower reading means the window reset, so the old readings no longer apply
  if (last && window.percentUsed < last.percent) readings = []
  if (!last || window.percentUsed !== last.percent) readings.push({ at: now, percent: window.percentUsed })
  readings = readings.filter(reading => now - reading.at <= 2 * BURN_LOOKBACK)
}

// How fast the 5 hour window fills, and whether that pace reaches 100% before it resets
function burnRate(now: number): Burn | undefined {
  const latest = readings[readings.length - 1]
  if (!latest) return undefined
  const base = [...readings].reverse().find(reading => now - reading.at >= BURN_LOOKBACK) ?? readings[0]
  if (!base || now - base.at < BURN_MIN_SPAN) return undefined
  const perHour = (latest.percent - base.percent) / ((now - base.at) / HOUR)
  if (perHour < 1) return undefined
  const minutesToFull = ((100 - latest.percent) / perHour) * 60
  const minutesToReset = resetsAt === undefined ? Infinity : (resetsAt - now) / MINUTE
  if (minutesToFull >= minutesToReset) return { perHour, level: 'calm' }
  return { perHour, level: minutesToFull < 60 ? 'hot' : 'warm', minutesLeft: minutesToFull }
}

// One bar per minute, scaled to the busiest minute; nothing when there was no spending
function tokenChart(now: number): Tokens | undefined {
  spends = spends.filter(spend => now - spend.at < CHART_MINUTES * MINUTE)
  const minutes = new Array<number>(CHART_MINUTES).fill(0)
  for (const spend of spends) {
    const index = CHART_MINUTES - 1 - Math.floor((now - spend.at) / MINUTE)
    minutes[index] = (minutes[index] ?? 0) + spend.tokens
  }
  const busiest = Math.max(...minutes)
  if (busiest === 0) return undefined
  const bars = minutes.map(tokens => BARS[Math.round((tokens / busiest) * (BARS.length - 1))]).join('')
  return { bars, perMinute: minutes[CHART_MINUTES - 1] ?? 0 }
}

async function refreshPace($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const burn = burnRate(now)
  const tokens = tokenChart(now)
  const current = await read($, line)
  if (JSON.stringify([current.burn, current.tokens]) === JSON.stringify([burn, tokens])) return
  await set($, { burn, tokens })
}

// The whole percent last sent to pawprints per window, so a reading goes out
// only when a window moves a whole point.
const sentLimits = new Map<string, number>()

// Sends usage-limit readings to pawprints, which charts them over time.
async function sendLimits($: EngineInterface, options: PluginOptions, windows: readonly SessionRateLimit[]): Promise<void> {
  if (!hasPawprints || !shows(options, 'sendLimits')) return
  for (const window of windows) {
    const whole = Math.floor(window.percentUsed)
    if (sentLimits.get(window.kind) === whole) continue
    const argv = ['pawprints', 'limits', 'record', '--session', await $.session.id(), '--kind', window.kind, '--percent', String(window.percentUsed)]
    if (window.resetsAt) argv.push('--resets-at', window.resetsAt)
    try {
      const ran = await $.process.run(argv, { timeoutMs: 5000 })
      if (ran.exitCode === 0) sentLimits.set(window.kind, whole)
    } catch {
      hasPawprints = false
      return
    }
  }
}

function shows(options: PluginOptions, part: string): boolean {
  return options[part] !== false
}

// The line without colours, for the dim hint row under the prompt
function plainText(options: PluginOptions, { model, effort, limits, contextPercent, edits, burn, tokens }: Line): string {
  const level = burn?.level ?? 'calm'
  const usage = limits.length > 0 && `📊 ${limits.map(limit => `${limit.percent}%`).join('/')}`
  const rate = burn && shows(options, 'showBurnRate') && `↗${Math.round(burn.perHour)}%/h`
  const left = burn?.minutesLeft !== undefined && `full in ${shortDuration(burn.minutesLeft)}`
  return [
    shows(options, 'showModel') && model && `🐱 ${shortModel(model)}`,
    shows(options, 'showEffort') && effort && `⚡ ${effort}`,
    shows(options, 'showUsage') && usage && [usage, rate, rate && left].filter(Boolean).join(' '),
    shows(options, 'showTokens') &&
      tokens &&
      [LEVEL_EMOJI[level], shows(options, 'showTokenChart') && tokens.bars, `${shortNumber(tokens.perMinute)}/m`].filter(Boolean).join(' '),
    shows(options, 'showContext') && contextPercent !== undefined && `🧠 ${contextPercent}%`,
    shows(options, 'showEdits') && edits && `🐾 ${edits.files} +${edits.added} −${edits.removed}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

async function refreshEdits($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!shows(options, 'showEdits')) return
  const edits = await readEdits($)
  if (edits) await set($, { edits })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    recordReading(usage.rateLimits, await $.clock.now())
    await sendLimits($, options, usage.rateLimits)
    await set($, {
      model: await $.session.model(),
      limits: toLimits(usage.rateLimits),
      contextPercent: usage.context.percent,
    })
    // Lets the burn rate and the chart fall back while nothing is happening
    $.clock.every(REFRESH_EVERY, () => void refreshPace($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    recordReading(e.rateLimits, await $.clock.now())
    await sendLimits($, options, e.rateLimits)
    await set($, {
      model: await $.session.model(),
      limits: toLimits(e.rateLimits),
      contextPercent: e.context.percent,
    })
    await refreshPace($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      promptStartedAt = await $.clock.now()
      await set($, { edits: undefined })
    }
    return next(e)
  })

  // Each step after the first follows tool results, so new edits are in pawprints by then
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      await set($, {
        effort: e.effort === undefined ? undefined : String(e.effort),
        contextPercent: usage.context.percent,
      })
      if (e.index > 0) await refreshEdits($, options)
    }
    const result = yield* next(e)
    if (result.usage) {
      const { input_tokens, cache_creation_input_tokens, output_tokens } = result.usage
      spends.push({ at: await $.clock.now(), tokens: input_tokens + cache_creation_input_tokens + output_tokens })
      await refreshPace($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await refreshEdits($, options)
    return result
  })

  if (options.position !== 'above') {
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
      const text = plainText(options, await read($, line))
      if (!text) return next(e)
      return next({ ...e, props: { ...e.props, tail: text } })
    })
    return
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { model, effort, limits, contextPercent, edits, burn, tokens } = await read($, line)
    const { Box, Text } = $.ui.resolve(e)
    const level = burn?.level ?? 'calm'

    const parts = [
      shows(options, 'showModel') && model && <Text color="inactive">🐱 {shortModel(model)}</Text>,
      shows(options, 'showEffort') && effort && <Text color="inactive">⚡ {effort}</Text>,
      shows(options, 'showUsage') && limits.length > 0 && (
        <Text color="inactive">
          {'📊 '}
          {limits.map((limit, index) => (
            <Text color={percentColor(limit.percent)}>
              {index > 0 ? '/' : ''}
              {limit.percent}%
            </Text>
          ))}
          {burn && shows(options, 'showBurnRate') && (
            <Text color={LEVEL_COLOR[level]}>
              {` ↗${Math.round(burn.perHour)}%/h`}
              {burn.minutesLeft !== undefined ? ` full in ${shortDuration(burn.minutesLeft)}` : ''}
            </Text>
          )}
        </Text>
      ),
      shows(options, 'showTokens') && tokens && (
        <Text color="inactive">
          {`${LEVEL_EMOJI[level]} `}
          {shows(options, 'showTokenChart') && <Text color={LEVEL_COLOR[level]}>{`${tokens.bars} `}</Text>}
          <Text color={LEVEL_COLOR[level]}>{`${shortNumber(tokens.perMinute)}/m`}</Text>
        </Text>
      ),
      shows(options, 'showContext') && contextPercent !== undefined && (
        <Text color="inactive">
          {'🧠 '}
          <Text color={percentColor(contextPercent)}>{contextPercent}%</Text>
        </Text>
      ),
      shows(options, 'showEdits') && edits && (
        <Text color="inactive">
          {`🐾 ${edits.files} `}
          <Text color="diffAdded">+{edits.added}</Text> <Text color="diffRemoved">−{edits.removed}</Text>
        </Text>
      ),
    ].filter(part => part !== undefined && part !== false && part !== '')

    if (parts.length === 0) return next(e)

    return (
      <Box marginTop={1}>
        {parts.map((part, index) => (
          <Text color="inactive">
            {index > 0 ? ' · ' : ''}
            {part}
          </Text>
        ))}
      </Box>
    )
  })
}
