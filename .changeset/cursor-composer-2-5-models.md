---
"@in-the-loop-labs/pair-review": patch
---

Refresh Cursor Agent built-in models around Composer 2.5

- `composer-2.5` is the new default (balanced) and `composer-2.5-fast` the fast-tier
  model used for JSON extraction and hunk summaries. `gpt-5.3-codex-high` stays
  the thorough-tier model.
- `composer-2` is now an alias of `composer-2.5`: same model line and same price.
- Removed superseded ids: `composer-1.5` (the previous default), `composer-2-fast`,
  `gpt-5.3-codex-fast`, `gpt-5.3-codex-xhigh`, `gpt-5.4-high`, `gpt-5.4-medium`,
  `sonnet-4.5-thinking`, `sonnet-4.6-thinking`, `opus-4.5-thinking`,
  `opus-4.6-thinking`, `gemini-3-flash`, and `gemini-3.1-pro`. Any model your Cursor
  account enables can still be named through `--model` or
  `providers.cursor-agent.models` (see `cursor-agent --list-models`).
