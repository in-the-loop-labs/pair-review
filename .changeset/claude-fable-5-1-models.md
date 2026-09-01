---
"@in-the-loop-labs/pair-review": patch
---

Add Claude Fable 5.1 models to the Claude provider

Two new thorough-tier entries, `fable-5.1-xhigh` and `fable-5.1-high`, pinned to
the `claude-fable-5-1` CLI model with `CLAUDE_CODE_EFFORT_LEVEL` set to `xhigh`
and `high` respectively. Like Fable 5, both are adaptive-thinking-only and
override the global `--thinking enabled` base argument.

The Fable 5 entries remain available, and the bare `fable` alias still resolves
to `fable-5-xhigh` so existing configs and `--model fable` invocations are
unchanged (mirroring how `opus` stayed on `opus-4.8-xhigh` when Opus 5 landed).
Fable 5 copy now reads as the previous Fable generation rather than a brand-new
tier.

Note: running these models requires a Claude Code CLI build that knows
`claude-fable-5-1`; older CLIs reject the model name. Use a per-model
`cli_model` override in `~/.pair-review/config.json` if you need a different ID.
