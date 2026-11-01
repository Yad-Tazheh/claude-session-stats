import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Stats } from '../types'

const EMPTY: Stats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftCount: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
}

const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, EMPTY)
const context = atom({ plugin: 'session-stats', key: 'context' } as const, null)
const isHidden = atom({ plugin: 'session-stats', key: 'isHidden' } as const, false)
const isPinned = atom({ plugin: 'session-stats', key: 'isPinned' } as const, false)

type IconMode = 'auto' | 'nerd' | 'unicode'
type RenderInput = Parameters<EngineInterface['ui']['resolve']>[0]

// Nerd Font glyphs (Material Design range)
const NERD = {
  time: '\u{f051b}', // md-timer_outline
  speed: '\u{f04c5}', // md-speedometer
  tokens: '\u{f01bc}', // md-database
  cache: '\u{f140b}', // md-lightning_bolt
  // md-circle_slice_1..8, picked by how full the context is
  slices: ['\u{f0a9e}', '\u{f0a9f}', '\u{f0aa0}', '\u{f0aa1}', '\u{f0aa2}', '\u{f0aa3}', '\u{f0aa4}', '\u{f0aa5}'],
}
// For terminals without a Nerd Font
const PLAIN = {
  time: '⏱',
  speed: '»',
  tokens: '⛁',
  cache: 'ϟ',
  slices: ['○', '◔', '◑', '◕', '●'],
}

const HEX: Record<string, string> = {
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  green: '#4ade80',
  yellow: '#facc15',
  red: '#f87171',
}

const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 14px desktop icons; the <title> is the hover tooltip
const svgIcon = (kind: 'time' | 'tokens' | 'ctx', color: string, tip: string, percent: number) => {
  const c = HEX[color] ?? color
  let body: string
  if (kind === 'time') {
    body =
      `<circle cx="8" cy="9" r="5.5" fill="none" stroke="${c}" stroke-width="1.6"/>` +
      `<path d="M8 6v3.2l2 1.3M6.5 1.8h3" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
  } else if (kind === 'tokens') {
    body =
      `<ellipse cx="8" cy="4" rx="5.5" ry="2.2" fill="none" stroke="${c}" stroke-width="1.5"/>` +
      `<path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" fill="none" stroke="${c}" stroke-width="1.5"/>`
  } else {
    // A pie filled to the context percentage
    const a = (Math.min(Math.max(percent, 1), 99.9) / 100) * 2 * Math.PI
    const x = (8 + 6 * Math.sin(a)).toFixed(2)
    const y = (8 - 6 * Math.cos(a)).toFixed(2)
    body =
      `<circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-opacity=".35" stroke-width="1.6"/>` +
      `<path d="M8 8V2A6 6 0 ${a > Math.PI ? 1 : 0} 1 ${x} ${y}Z" fill="${c}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16"><title>${esc(tip)}</title>${body}</svg>`
}

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h${m}m` : m ? `${m}m${s % 60}s` : `${s}s`
}

async function refreshContext($: EngineInterface) {
  const { context: c } = await $.session.usage({ breakdown: 'summary' })
  const rows = (c.breakdown?.categories ?? [])
    .filter(r => r.kind === 'used' && r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4)
    .map(r => ({ name: r.name, tokens: r.tokens }))
  const next: Context = {
    percent: c.percent ?? 0,
    tokens: c.tokens ?? 0,
    window: c.window,
    rows,
  }
  await update($, context, () => next)
}

// The stats row, the pinned detail lines, or both with hover cards (`site`)
async function drawStats($: EngineInterface, e: RenderInput, iconMode: IconMode, site: 'band' | 'lines' | 'hint', hint = '') {
  const s = await read($, stats)
  const c = await read($, context)
  const pinned = await read($, isPinned)

  const table = $.ui.resolve(e) as { Box: any; Text: any; Button: any; Svg?: any }
  const { Box, Button, Text } = table
  const Svg = e.surface === 'terminal' ? undefined : table.Svg
  const mode = iconMode === 'auto' ? (Svg ? 'svg' : 'nerd') : iconMode
  const glyphs = mode === 'unicode' ? PLAIN : NERD

  const tokens = s.input + s.cacheRead + s.cacheWrite + s.output
  const promptIn = s.input + s.cacheRead + s.cacheWrite
  const cacheHit = promptIn ? Math.round((s.cacheRead / promptIn) * 100) : 0
  const tps = s.llmMs ? Math.round(s.output / (s.llmMs / 1000)) : 0
  const ttft = s.ttftCount ? (s.ttftMs / s.ttftCount / 1000).toFixed(1) : '-'
  const hitColor = cacheHit >= 80 ? 'green' : cacheHit >= 50 ? 'yellow' : 'red'
  const pct = c?.percent ?? 0
  const ctxColor = pct < 50 ? 'green' : pct < 80 ? 'yellow' : 'red'
  const slice = glyphs.slices[Math.min(glyphs.slices.length - 1, Math.floor((pct / 100) * glyphs.slices.length))] ?? ''

  // A segment is [text, color]; no color draws it dim
  type Seg = [string, string?]
  type Group = { key: string; kind: 'time' | 'tokens' | 'ctx'; icon: string; accent: string; label: Seg[]; detail: Seg[] }
  const SEP: Seg = [' · ']

  const groups: Group[] = [
    {
      key: 'time',
      kind: 'time',
      icon: glyphs.time,
      accent: 'blue',
      label: [
        [`${s.turns}`, 'white'], [' turns '], [`${s.steps}`, 'white'], [' steps'], SEP,
        [`${glyphs.speed} ${tps}`, 'cyan'], [' tok/s'],
      ],
      detail: [
        ['LLM time '], [fmtDur(s.llmMs), 'blue'], SEP,
        ['Tool time '], [fmtDur(s.toolMs), 'magenta'], SEP,
        ['Avg TTFT '], [`${ttft}s`, 'yellow'], SEP,
        [`${tps}`, 'cyan'], [' tok/s'],
      ],
    },
    {
      key: 'tok',
      kind: 'tokens',
      icon: glyphs.tokens,
      accent: 'magenta',
      label: [[fmtTok(tokens), 'white'], [' tok'], SEP, [`${glyphs.cache} `, hitColor], ['Cache hit '], [`${cacheHit}%`, hitColor]],
      detail: [
        ['Uncached in '], [fmtTok(s.input), 'yellow'], SEP,
        ['Cache write '], [fmtTok(s.cacheWrite), 'magenta'], SEP,
        ['Cached in '], [fmtTok(s.cacheRead), 'green'], SEP,
        ['Output '], [fmtTok(s.output), 'cyan'],
      ],
    },
  ]
  if (c) {
    groups.push({
      key: 'ctx',
      kind: 'ctx',
      icon: slice,
      accent: ctxColor,
      label: [[`${c.percent}%`, ctxColor], [' context']],
      detail: [
        [fmtTok(c.tokens), ctxColor], [` / ${fmtTok(c.window)}`],
        ...c.rows.flatMap((r, i): Seg[] => [SEP, [`${r.name} `], [fmtTok(r.tokens), ['blue', 'magenta', 'cyan', 'yellow'][i]]]),
      ],
    })
  }

  const draw = (segs: Seg[]) =>
    segs.map(([text, color], i) =>
      color ? (
        <Text key={`${i}`} color={color}>
          {text}
        </Text>
      ) : (
        <Text key={`${i}`} dimColor>
          {text}
        </Text>
      ),
    )
  const plain = (segs: Seg[]) => segs.map(([t]) => t).join('')
  const width = (segs: Seg[]) => segs.reduce((n, [t]) => n + t.length, 0)

  const icon = (g: Group) =>
    mode === 'svg' ? (
      <Svg source={svgIcon(g.kind, g.accent, plain(g.detail), pct)} alt={plain(g.detail)} width={14} height={14} isInteractive />
    ) : (
      <Text color={g.accent}>{g.icon} </Text>
    )

  const lines = (
    <Box flexDirection="column">
      {groups.map(g => (
        <Text key={g.key}>
          <Text color={g.accent}>{mode === 'svg' ? '│' : g.icon} </Text>
          {draw(g.detail)}
        </Text>
      ))}
    </Box>
  )
  if (site === 'lines') return lines

  const GAP = 3
  let col = hint ? hint.length + GAP : 0
  const row = (
    <Box flexDirection="row">
      {hint ? (
        <Box marginRight={GAP}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
      {groups.map(g => {
        const left = -col
        col += width(g.label) + 2 + GAP
        return (
          <Box key={g.key} marginRight={GAP} flexDirection="row" gap={mode === 'svg' ? 1 : 0}>
            {icon(g)}
            <Text hover={{ bold: true }}>{draw(g.label)}</Text>
            {site === 'band' && mode !== 'svg' ? (
              <Box position="absolute" top={1} left={left} display="none" hover={{ display: 'flex' }}>
                <Text>{draw(g.detail)}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      <Button key="pin" label={pinned ? 'less' : 'details'} onPress={() => update($, isPinned, v => !v)} />
    </Box>
  )
  if (site === 'hint') return row

  return (
    <Box flexDirection="column">
      {row}
      {pinned ? lines : <Text dimColor> </Text>}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const position = options.position === 'above' ? 'above' : 'below'
  const iconMode: IconMode = options.icons === 'nerd' || options.icons === 'unicode' ? options.icons : 'auto'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'statsbar', description: 'Show or hide the session stats bar', argumentHint: '[show|hide]' })
    return next(e)
  })

  on('command.run', { command: 'statsbar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const want = ['show', 'on'].includes(arg) ? false : ['hide', 'off'].includes(arg) ? true : undefined
    const hidden = await update($, isHidden, v => want ?? !v)
    return { text: hidden ? 'Stats bar hidden.' : 'Stats bar shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, stats, s => ({ ...s, turns: s.turns + 1 }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstAt = 0
    const stream = next(e)
    for await (const chunk of stream) {
      if (!firstAt) firstAt = await $.clock.now()
      yield chunk
    }
    const result = await stream.result
    const endedAt = await $.clock.now()
    const u = result.usage
    await update($, stats, s => ({
      ...s,
      steps: s.steps + 1,
      llmMs: s.llmMs + (endedAt - startedAt),
      ttftMs: s.ttftMs + (firstAt ? firstAt - startedAt : 0),
      ttftCount: s.ttftCount + (firstAt ? 1 : 0),
      input: s.input + (u?.input_tokens ?? 0),
      cacheRead: s.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: s.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      output: s.output + (u?.output_tokens ?? 0),
    }))
    if (!e.agentId) await refreshContext($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    // Agent's time is the subagent's own LLM + tool time, already counted
    if (e.tool === 'Agent') return next(e)
    const startedAt = await $.clock.now()
    try {
      return await next(e)
    } finally {
      const ms = (await $.clock.now()) - startedAt
      await update($, stats, s => ({ ...s, toolMs: s.toolMs + ms }))
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden)) || (await read($, stats)).steps === 0) return next(e)
    if (position === 'above') return drawStats($, e, iconMode, 'band')
    // Below the prompt, the band holds only the pinned details
    return (await read($, isPinned)) ? drawStats($, e, iconMode, 'lines') : next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (position !== 'below' || (await read($, isHidden)) || (await read($, stats)).steps === 0) return next(e)
    return drawStats($, e, iconMode, 'hint', e.props.hint)
  })
}
