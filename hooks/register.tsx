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
const isBusy = atom({ plugin: 'session-stats', key: 'isBusy' } as const, false)
// Output tok/s of the latest steps, oldest first: the pulse line
const spark = atom({ plugin: 'session-stats', key: 'spark' } as const, [] as number[])
const SPARK_KEEP = 24

// Noctalia's dark palette (noctalia-dev/noctalia-shell, Noctalia-default) for the named colors
const NOCTALIA: Record<string, string> = {
  white: '#f3edf7',
  blue: '#a9aefe',
  cyan: '#9BFECE',
  green: '#9BFECE',
  yellow: '#fff59b',
  red: '#FD4663',
  magenta: '#7c80b4',
}
const tint = (color: string) => NOCTALIA[color] ?? color
// Near the app's own frame gray, a touch of Noctalia indigo: the band, and its cards
const BAND_BG = '#22222c'
const CARD_BG = '#15151d'
// The prompt-in count, in the bar and the report
const IN_COLOR = '#FF00FF'
// The output count; and a peach for write/new and the fourth context row
const OUT_COLOR = '#03EFFC'
const ACCENT_ORANGE = '#FFB38A'

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h${m}m` : m ? `${m}m${s % 60}s` : `${s}s`
}

// A segmented meter: ▰ filled, ▱ empty
const meter = (pct: number, n: number) => {
  const on = Math.max(0, Math.min(n, Math.round((pct / 100) * n)))
  return '▰'.repeat(on) + '▱'.repeat(n - on)
}

// A braille sparkline scaled to its own peak: dots fill as the rate climbs
const sparkline = (xs: number[]) => {
  const bars = '⡀⣀⣄⣤⣦⣶⣷⣿'
  const peak = Math.max(1, ...xs)
  return xs.map(x => bars[Math.min(7, Math.round((x / peak) * 7))] ?? '▁').join('')
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'statsbar', description: 'Show or hide the session stats band', argumentHint: '[show|hide]' })
    // A context reading lets the band draw before the first model request
    await refreshContext($).catch(() => {})
    // A resumed session starts idle, whatever the last one left
    await update($, isBusy, () => false)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'statsbar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const want = ['show', 'on'].includes(arg) ? false : ['hide', 'off'].includes(arg) ? true : undefined
    const hidden = await update($, isHidden, v => want ?? !v)
    if (!hidden) await refreshContext($).catch(() => {})
    // An unchanged value draws nothing new; redraw anyway so `show` always shows
    $.ui.invalidate('ui.render')
    return { text: hidden ? 'Stats band hidden.' : 'Stats band shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await update($, stats, s => ({ ...s, turns: s.turns + 1 }))
      await update($, isBusy, () => true)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await update($, isBusy, () => false)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A step is work: live, even if the turn's start was missed
    if (!e.agentId) await update($, isBusy, () => true)
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
    const secs = (endedAt - startedAt) / 1000
    const rate = secs > 0 ? Math.round((u?.output_tokens ?? 0) / secs) : 0
    await update($, spark, xs => [...xs, rate].slice(-SPARK_KEEP))
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
    const s = await read($, stats)
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const c = await read($, context)
    if (s.steps === 0 && !c) return next(e)
    const pinned = await read($, isPinned)
    const busy = await read($, isBusy)
    const pulse = await read($, spark)
    const { Box, Button, Text } = $.ui.resolve(e)

    const tokens = s.input + s.cacheRead + s.cacheWrite + s.output
    const promptIn = s.input + s.cacheRead + s.cacheWrite
    const cacheHit = promptIn ? Math.round((s.cacheRead / promptIn) * 100) : 0
    const tps = s.llmMs ? Math.round(s.output / (s.llmMs / 1000)) : 0
    const ttft = s.ttftCount ? (s.ttftMs / s.ttftCount / 1000).toFixed(1) : '-'
    const hitColor = cacheHit >= 80 ? 'green' : cacheHit >= 50 ? 'yellow' : 'red'
    const ctxPct = c?.percent ?? 0
    const ctxColor = ctxPct < 50 ? 'green' : ctxPct < 80 ? 'yellow' : 'red'

    // A segment is [text, color]; no color draws it dim
    type Seg = [string, string?]
    type Group = { key: string; label: Seg[]; detail: Seg[] }
    // Popups stay short: the desktop wraps a floating card past about 40 characters
    const SEP: Seg = [' · ']

    // Cells the band may use; 0 where no surface has measured
    const avail = (e.props.bodyColumns || e.viewport?.columns || 0) - 2
    // An emoji takes two cells; its variation selector none
    const cells = (t: string) =>
      [...t].reduce((n, ch) => {
        const cp = ch.codePointAt(0) ?? 0
        return n + (cp === 0xfe0f ? 0 : cp >= 0x1f000 || (cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1)
      }, 0)
    const width = (segs: Seg[]) => segs.reduce((n, [t]) => n + cells(t), 0)
    const GAP = 2

    const draw = (segs: Seg[]) =>
      segs.map(([text, color], i) =>
        color ? (
          <Text key={`${i}`} color={tint(color)}>
            {text}
          </Text>
        ) : (
          <Text key={`${i}`} dimColor>
            {text}
          </Text>
        ),
      )

    // The left side: mark, state, counts and the pulse; one pressable with the gap
    const state: Seg[] = busy ? [['◉ ', 'yellow'], ['live', 'yellow']] : [['○ '], ['standby']]
    const brand = (wide: boolean): Seg[] => [
      [' '],
      ...state,
      ['  '],
      [`${s.turns}`, 'white'],
      ['/'],
      [`${s.steps}`, 'white'],
      // The pulse stays in both forms: the last 12 steps, or 6 when narrow
      ...(pulse.length > 1 ? ([['  '], [sparkline(pulse.slice(wide ? -12 : -6)), 'yellow']] as Seg[]) : []),
    ]

    const right = (wide: boolean): Group[] => [
      {
        key: 'hit',
        label: wide
          ? [['⚡ '], [`${cacheHit}% `, hitColor], [meter(cacheHit, 5), hitColor]]
          : [['⚡'], [`${cacheHit}%`, hitColor]],
        detail: [
          ['Cached '], [fmtTok(s.cacheRead), 'green'], SEP,
          ['Written '], [fmtTok(s.cacheWrite), ACCENT_ORANGE], SEP,
          ['New '], [fmtTok(s.input), 'yellow'],
        ],
      },
      ...(c
        ? [
            {
              key: 'ctx',
              label: (wide
                ? [['◔ '], [`${c.percent}% `, ctxColor], [meter(c.percent, 5), ctxColor]]
                : [['◔'], [`${c.percent}%`, ctxColor]]) as Seg[],
              detail: [
                [fmtTok(c.tokens), ctxColor], [` / ${fmtTok(c.window)}`],
                ...c.rows.slice(0, 1).flatMap((r): Seg[] => [SEP, [`${r.name} `], [fmtTok(r.tokens), 'blue']]),
              ] as Seg[],
            },
          ]
        : []),
      {
        key: 'io',
        label: [['↑', IN_COLOR], [fmtTok(promptIn), IN_COLOR], [' ↓'], [fmtTok(s.output), OUT_COLOR]],
        detail: [
          ['Total '], [fmtTok(tokens), 'white'], SEP,
          [`${tps}`, 'cyan'], [' tok/s'],
        ],
      },
      {
        key: 'time',
        label: [['⏱ '], [fmtDur(s.llmMs + s.toolMs), 'white']],
        detail: [
          ['LLM '], [fmtDur(s.llmMs), 'blue'], SEP,
          ['Tools '], [fmtDur(s.toolMs), 'magenta'], SEP,
          ['TTFT '], [`${ttft}s`, 'yellow'],
        ],
      },
    ]

    // The widest form that fits: meters and pulse first to go
    const total = (wideLeft: boolean, gauges: boolean) =>
      width(brand(wideLeft)) + right(gauges).reduce((n, g) => n + width(g.label) + GAP, 0) + 6
    const room = (wideLeft: boolean, g: boolean) => !avail || total(wideLeft, g) <= avail
    // Gauges ride beside the percents only while live; standby shows the numbers alone.
    // Live, the gauges win over the long pulse: it shortens before they drop
    const gauges = busy && room(false, true)
    const fits = room(true, gauges)
    const left = brand(fits)
    const groups = right(gauges)
    const fill = Math.max(2, avail ? avail - total(fits, gauges) + 2 : 4)
    const terminal = e.surface === 'terminal'

    const sep = (
      <Text key="sep" color="#45455c">
        {'│'}
      </Text>
    )


    // The report: titled sections of label / value rows, wrapping when narrow
    type Row = [string, string, string?]
    const section = (key: string, title: string, accent: string, rows: Row[], extra?: ReturnType<typeof Text>) => (
      <Box key={key} flexDirection="column" marginRight={3} flexShrink={1}>
        <Text color={tint(accent)} bold>
          {`▍${title}`}
        </Text>
        {extra ?? null}
        {rows.map(([label, value, color]) => (
          <Box key={label} flexDirection="row">
            <Box width={13} flexShrink={0}>
              <Text dimColor>{label}</Text>
            </Box>
            <Text color={tint(color ?? 'white')}>{value}</Text>
          </Box>
        ))}
      </Box>
    )
    const bar = (pct: number, color: string, note: string) => (
      <Text key="bar">
        <Text color={tint(color)}>{meter(pct, 10)}</Text>
        <Text color={tint(color)}>{`  ${note}`}</Text>
      </Text>
    )

    // Three columns of at most five lines, so the report fits without a scroll
    const report = pinned ? (
      <Box key="report" flexDirection="row" backgroundColor={CARD_BG} paddingX={1} marginTop={1}>
        {section('act', 'ACTIVITY', 'blue', [
          ['Turns/steps', `${s.turns}/${s.steps}`],
          ['Output', `${tps} tok/s`, 'cyan'],
          ['TTFT', `${ttft}s`, 'yellow'],
          ['LLM/tools', `${fmtDur(s.llmMs)}/${fmtDur(s.toolMs)}`, 'blue'],
          ...(pulse.length > 1 ? ([['Pulse', sparkline(pulse.slice(-10)), 'yellow']] as Row[]) : []),
        ])}
        {section(
          'tok',
          'TOKENS',
          hitColor,
          [
            ['In', fmtTok(promptIn), IN_COLOR],
            ['Out', fmtTok(s.output), OUT_COLOR],
            ['Cached', fmtTok(s.cacheRead), 'green'],
            ['Write/new', `${fmtTok(s.cacheWrite)}/${fmtTok(s.input)}`, ACCENT_ORANGE],
          ],
          bar(cacheHit, hitColor, `${cacheHit}% hit`),
        )}
        {c
          ? section(
              'ctx',
              'CONTEXT',
              ctxColor,
              c.rows.slice(0, 4).map((r, i): Row => [r.name, fmtTok(r.tokens), ['blue', 'magenta', 'cyan', ACCENT_ORANGE][i]]),
              bar(c.percent, ctxColor, `${c.percent}% of ${fmtTok(c.window)}`),
            )
          : null}
      </Box>
    ) : null

    // A one-glyph Button, a Claude-style spark: a press opens or closes the report
    const dot = '✻'

    return (
      <Box flexDirection="column" backgroundColor={BAND_BG} paddingX={1}>
        <Box key="bar" flexDirection="row" flexWrap="wrap">
          <Box key="open" flexGrow={1} flexDirection="row">
            <Box key="dot" flexShrink={0}>
              <Button key="dot" plain label={dot} hover={{ bold: true }} onPress={() => update($, isPinned, v => !v)} />
            </Box>
            <Text>{draw(left)}</Text>
            <Text>{' '.repeat(fill)}</Text>
          </Box>
          {groups.map(g => (
            // The hover card is a child of the keyed Box, pinned to its right edge
            <Box key={g.key} flexShrink={0} flexDirection="row">
              {sep}
              <Text hover={{ bold: true }}>{draw([[' '], ...g.label, [' ']])}</Text>
              <Box
                position="absolute"
                top={1}
                right={0}
                display="none"
                hover={{ display: 'flex' }}
                backgroundColor={CARD_BG}
                paddingX={1}
                // Wide enough for the whole card: one line, never wrapped
                // The desktop's proportional font and emoji run wider than cells: give it room
                width={terminal ? width(g.detail) + 2 : Math.ceil(width(g.detail) * 1.5) + 4}
                flexShrink={0}
              >
                <Text wrap="truncate-end">{draw(g.detail)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
        {report}
        {!pinned && terminal ? (
          // The terminal paints the hover card into this row; the desktop floats it
          <Text dimColor> </Text>
        ) : null}
      </Box>
    )
  })
}
