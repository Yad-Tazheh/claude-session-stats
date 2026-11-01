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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'statsbar', description: 'Show or hide the session stats band', argumentHint: '[show|hide]' })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'statsbar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const want = ['show', 'on'].includes(arg) ? false : ['hide', 'off'].includes(arg) ? true : undefined
    const hidden = await update($, isHidden, v => want ?? !v)
    // An unchanged value draws nothing new; redraw anyway so `show` always shows
    $.ui.invalidate('ui.render')
    return { text: hidden ? 'Stats band hidden.' : 'Stats band shown.' }
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
    const s = await read($, stats)
    if (e.props.hasSurvey || s.steps === 0 || (await read($, isHidden))) return next(e)

    const c = await read($, context)
    const pinned = await read($, isPinned)
    const { Box, Button, Text } = $.ui.resolve(e)

    const tokens = s.input + s.cacheRead + s.cacheWrite + s.output
    const promptIn = s.input + s.cacheRead + s.cacheWrite
    const cacheHit = promptIn ? Math.round((s.cacheRead / promptIn) * 100) : 0
    const tps = s.llmMs ? Math.round(s.output / (s.llmMs / 1000)) : 0
    const ttft = s.ttftCount ? (s.ttftMs / s.ttftCount / 1000).toFixed(1) : '-'
    const hitColor = cacheHit >= 80 ? 'green' : cacheHit >= 50 ? 'yellow' : 'red'
    const ctxColor = !c || c.percent < 50 ? 'green' : c.percent < 80 ? 'yellow' : 'red'

    // A segment is [text, color]; no color draws it dim
    type Seg = [string, string?]
    type Group = { key: string; accent: string; label: Seg[]; detail: Seg[] }
    const SEP: Seg = [' · ']

    const groups: Group[] = [
      {
        key: 'time',
        accent: 'blue',
        label: [['⏱ ', 'blue'], [`${s.turns}`, 'white'], [' turns '], [`${s.steps}`, 'white'], [' steps'], SEP, [`${tps}`, 'cyan'], [' tok/s']],
        detail: [
          ['LLM time '], [fmtDur(s.llmMs), 'blue'], SEP,
          ['Tool time '], [fmtDur(s.toolMs), 'magenta'], SEP,
          ['Avg TTFT '], [`${ttft}s`, 'yellow'], SEP,
          [`${tps}`, 'cyan'], [' tok/s'],
        ],
      },
      {
        key: 'tok',
        accent: 'magenta',
        label: [['⛁ ', 'magenta'], [fmtTok(tokens), 'white'], [' tok'], SEP, ['Cache hit '], [`${cacheHit}%`, hitColor]],
        detail: [
          ['Uncached in '], [fmtTok(s.input), 'yellow'], SEP,
          ['Cache write '], [fmtTok(s.cacheWrite), 'magenta'], SEP,
          ['Cached in '], [fmtTok(s.cacheRead), 'green'], SEP,
          ['Output '], [fmtTok(s.output), 'cyan'],
        ],
      },
      ...(c
        ? [
            {
              key: 'ctx',
              accent: ctxColor,
              label: [['◔ ', ctxColor], [`${c.percent}%`, ctxColor], [' context']] as Seg[],
              detail: [
                [fmtTok(c.tokens), ctxColor], [` / ${fmtTok(c.window)}`],
                ...c.rows.flatMap((r, i): Seg[] => [SEP, [`${r.name} `], [fmtTok(r.tokens), ['blue', 'magenta', 'cyan', 'yellow'][i]]]),
              ] as Seg[],
            },
          ]
        : []),
    ]

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
    const width = (segs: Seg[]) => segs.reduce((n, [t]) => n + t.length, 0)

    const GAP = 3
    let col = 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {groups.map(g => {
            const left = -col
            col += width(g.label) + GAP
            // The hover card is a child of the keyed Box, painted on the row below
            return (
              <Box key={g.key} marginRight={GAP}>
                <Text hover={{ bold: true }}>{draw(g.label)}</Text>
                <Box position="absolute" top={1} left={left} display="none" hover={{ display: 'flex' }}>
                  <Text>{draw(g.detail)}</Text>
                </Box>
              </Box>
            )
          })}
          <Button
            key="pin"
            label={pinned ? 'less' : 'details'}
            onPress={() => update($, isPinned, v => !v)}
          />
        </Box>
        {pinned ? (
          <Box flexDirection="column">
            {groups.map(g => (
              <Text key={g.key}>
                <Text color={g.accent}>{'│ '}</Text>
                {draw(g.detail)}
              </Text>
            ))}
          </Box>
        ) : e.surface === 'terminal' ? (
          // The terminal paints the hover card into this row; the desktop floats it
          <Text dimColor> </Text>
        ) : null}
      </Box>
    )
  })
}
