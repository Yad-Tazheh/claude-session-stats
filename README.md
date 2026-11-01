# session-stats

A Claude Code mod that shows a colored stats bar above the prompt:

```
⏱ 11 turns 308 steps · 215 tok/s   ⛁ 40.4M tok · Cache hit 97%   ◔ 24% context   [details]
```

- **⏱ time**: your turns, model requests (steps, subagents included) and output tokens per second.
- **⛁ tokens**: every token the session spent and the prompt-cache hit rate (green 80%+, yellow 50%+, red below).
- **◔ context**: how full the context window is (green under 50%, yellow under 80%, red above).

Hover a stat to see its details on the line below, or press **details** to pin all three:

- time: LLM time, tool time, average time to first token, tok/s
- tokens: uncached input, cache writes, cached input, output
- context: tokens used / window, and the largest categories (system prompt, tools, messages, ...)

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
