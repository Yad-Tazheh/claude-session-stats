# session-stats

A Claude Code mod that shows a one-row stats bar above the prompt, on a soft dark background with a Noctalia-style palette:

```
▶  ◉ live  22/97  ⣀⣤⣶⣷⣦⣤⣶⣄   │ ⧉ 98% ▰▰▰▰▰ │ ◔ 16% ▰▱▱▱▱ │ ↑14.4M ↓63.5k │ ⏱ 12m54s
```

- **▶** (purple) opens the full session report; it turns to **▼** while open.
- **◉ live / ○ standby**: whether the model is working right now (live takes the pulse color).
- **22/97**: your turns / model requests (steps, subagents included).
- **⣀⣤⣶ pulse**: output tok/s of the latest steps, as a braille sparkline, colored by model: Opus yellow, Fable orange, Haiku green, Sonnet magenta.
- **⧉ cache hit** and **◔ context used**: colored with gauges while live, gray percents alone on standby.
- **↑ in / ↓ out** tokens, and **⏱** active time (LLM + tools).

Hover a stat for a one-line detail popup. The report shows three columns:

- **ACTIVITY**: a glow gauge of the latest speed against the peak, then turns/steps, output tok/s, time to first token, LLM/tool time
- **TOKENS**: cache-hit gauge, in, out, cached, cache write / uncached
- **CONTEXT**: context gauge and the largest categories (messages, tools, system prompt, ...)

On a narrow panel the gauges and the long pulse go first, so nothing is cut off.

In a terminal the bar drops its background fills (many terminals lack true color) and uses solid blocks for the pulse and gauges.

`/statsbar show` or `/statsbar hide` sets the bar; `/statsbar` alone toggles it.

## Install

At the prompt of a terminal session:

```
/plugin install session-stats --marketplace Yad-Tazheh/claude-session-stats
```

Answer `y` to add the marketplace, then pick a scope (user is first; Enter takes it).

From a shell:

```bash
claude plugin install session-stats --marketplace Yad-Tazheh/claude-session-stats
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Yad-Tazheh/claude-session-stats`, then **Add plugin**.

## Notes

- Counts start when the mod loads; tool time leaves out the Agent tool, whose time is the subagent's own LLM and tool time.
- Function hooks are an early-access Claude Code surface and may change between releases.

## License

MIT
