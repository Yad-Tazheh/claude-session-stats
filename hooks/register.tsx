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
    await $.command.register({ name: 'statsbar', description: '显示或隐藏会话统计栏', argumentHint: '[show|hide]' })
    // A context reading lets the band draw before the first model request
    await refreshContext($).catch(() => {})
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
    return { text: hidden ? '统计栏已隐藏。' : '统计栏已显示。' }
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
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const c = await read($, context)
    if (s.steps === 0 && !c) return next(e)
    const pinned = await read($, isPinned)
    const { Box, Button, Text } = $.ui.resolve(e)

    const tokens = s.input + s.cacheRead + s.cacheWrite + s.output
    const promptIn = s.input + s.cacheRead + s.cacheWrite
    const cacheHit = promptIn ? Math.round((s.cacheRead / promptIn) * 100) : 0
    const tps = s.llmMs ? Math.round(s.output / (s.llmMs / 1000)) : 0
    const ttft = s.ttftCount ? (s.ttftMs / s.ttftCount / 1000).toFixed(1) : '-'
    const hitColor = cacheHit >= 80 ? 'green' : cacheHit >= 50 ? 'yellow' : 'red'
    const ctxColor = !c || c.percent < 50 ? 'green' : c.percent < 80 ? 'yellow' : 'red'
    const ctxIcon = '●'

    // A segment is [text, color]; no color draws it dim
    type Seg = [string, string?]
    type Group = { key: string; accent: string; label: Seg[]; detail: Seg[] }
    const SEP: Seg = [' · ']

    // Cells the band may use; 0 where no surface has measured
    const avail = e.props.bodyColumns || e.viewport?.columns || 0
    // An emoji takes two cells; its variation selector none
    const cells = (t: string) =>
      [...t].reduce((n, ch) => {
        const cp = ch.codePointAt(0) ?? 0
        return n + (cp === 0xfe0f ? 0 : (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef) || cp >= 0x1f000 || (cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1)
      }, 0)
    const width = (segs: Seg[]) => segs.reduce((n, [t]) => n + cells(t), 0)
    const GAP = 3
    const BUTTON = 11

    type Labels = { time: Seg[]; tok: Seg[]; ctx: Seg[] }
    const fullLabels: Labels = {
      time: [['回合 '], [`${s.turns}`, 'white'], ['  '], ['请求 '], [`${s.steps}`, 'white'], ['  '], ['速度 '], [`${tps}`, 'cyan'], [' tok/s']],
      tok: [['总计 '], [fmtTok(tokens), 'white'], [' tok  '], ['缓存命中 '], [`${cacheHit}%`, hitColor]],
      ctx: c ? [[`${ctxIcon} 上下文 `], [`${c.percent}%`, ctxColor]] : [],
    }
    // Short labels for a narrow band; the hover cards keep every number
    const shortLabels: Labels = {
      time: [['请求 '], [`${s.steps}`, 'white'], [' '], ['速度 '], [`${tps}`, 'cyan'], [' t/s']],
      tok: [['总计 '], [fmtTok(tokens), 'white'], [' '], ['命中 '], [`${cacheHit}%`, hitColor]],
      ctx: c ? [[`${ctxIcon} 上下文 `], [`${c.percent}%`, ctxColor]] : [],
    }
    const fullWidth = Object.values(fullLabels).reduce((n, l) => n + (l.length ? width(l) + GAP : 0), BUTTON)
    const labels = avail && fullWidth > avail ? shortLabels : fullLabels

    const groups: Group[] = [
      {
        key: 'time',
        accent: 'blue',
        label: labels.time,
        detail: [
          ['回合 '], [`${s.turns}`, 'white'], SEP,
          ['请求 '], [`${s.steps}`, 'white'], SEP,
          ['模型用时 '], [fmtDur(s.llmMs), 'blue'], SEP,
          ['工具用时 '], [fmtDur(s.toolMs), 'magenta'], SEP,
          ['首token '], [`${ttft}s`, 'yellow'], SEP,
          ['速度 '], [`${tps}`, 'cyan'], [' tok/s'],
        ],
      },
      {
        key: 'tok',
        accent: 'magenta',
        label: labels.tok,
        detail: [
          ['总计 '], [fmtTok(tokens), 'white'], SEP,
          ['缓存命中 '], [`${cacheHit}%`, hitColor], SEP,
          ['未缓存输入 '], [fmtTok(s.input), 'yellow'], SEP,
          ['缓存写入 '], [fmtTok(s.cacheWrite), 'magenta'], SEP,
          ['缓存读取 '], [fmtTok(s.cacheRead), 'green'], SEP,
          ['输出 '], [fmtTok(s.output), 'cyan'],
        ],
      },
      ...(c
        ? [
            {
              key: 'ctx',
              accent: ctxColor,
              label: labels.ctx,
              detail: [
                [`${ctxIcon} 已用 `], [fmtTok(c.tokens), ctxColor], [` / ${fmtTok(c.window)}`],
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
    // Pack whole groups into rows that fit, the button riding on the last
    let row: Group[] = []
    const rows = [row]
    let used = 0
    for (const g of groups) {
      const w = width(g.label) + GAP
      if (avail && used && used + w > avail) {
        row = []
        rows.push(row)
        used = 0
      }
      row.push(g)
      used += w
    }
    const lastRowFits = !avail || used + BUTTON <= avail
    const terminal = e.surface === 'terminal'

    const pin = (
      <Button
        key="pin"
        label={pinned ? '收起' : '详情'}
        onPress={() => update($, isPinned, v => !v)}
      />
    )

    return (
      <Box flexDirection="column">
        {rows.map((row, r) => {
          let col = 0
          return (
            <Box key={`row${r}`} flexDirection="row" flexWrap="wrap">
              {row.map(g => {
                const left = -col
                col += width(g.label) + GAP
                // The hover card is a child of the keyed Box: the desktop floats it
                // under the group; the terminal paints it into the spare row below all
                return (
                  <Box key={g.key} marginRight={GAP} flexShrink={0}>
                    <Text hover={{ bold: true }}>{draw(g.label)}</Text>
                    <Box
                      position="absolute"
                      top={terminal ? rows.length - r + (lastRowFits ? 0 : 1) : 1}
                      left={left}
                      display="none"
                      hover={{ display: 'flex' }}
                    >
                      <Text>{draw(g.detail)}</Text>
                    </Box>
                  </Box>
                )
              })}
              {r === rows.length - 1 && lastRowFits ? pin : null}
            </Box>
          )
        })}
        {lastRowFits ? null : <Box key="pinrow">{pin}</Box>}
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
