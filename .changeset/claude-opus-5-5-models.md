---
"@in-the-loop-labs/pair-review": patch
---

Add Claude Opus 5.5 models (`opus-5.5-xhigh`, `opus-5.5-high`) and make `opus-5.5-high` the default for new installs

The bare `opus` alias now resolves to Opus 5.5 XHigh (was Opus 4.8 XHigh), and `fable`
resolves to Fable 5.1 XHigh (was Fable 5 XHigh). Any config, council, `--model`, or
`disabled_models` entry that names an alias follows it. That includes the stock
`"default_model": "opus"` that earlier versions wrote to `~/.pair-review/config.json`.
To stay on the previous generation, name `opus-4.8-xhigh` or `fable-5-xhigh` explicitly.

Requires a Claude Code CLI that recognizes `claude-opus-5-5`. Use a per-model
`cli_model` override if you need a different ID.
