---
"@in-the-loop-labs/pair-review": patch
---

Add Claude Opus 4.7 (`opus-4.7-xhigh`) as a new built-in model

Adds `opus-4.7-xhigh`, pinned to the `claude-opus-4-7` CLI model with `CLAUDE_CODE_EFFORT_LEVEL=xhigh` for the deepest analysis. Also pins the existing `opus`, `opus-4.6-low`, `opus-4.6-medium`, and `opus-4.6-1m` entries to explicit `opus-4-6` / `opus-4-6[1m]` CLI model IDs so they no longer drift when the CLI's `opus` alias updates. `opus` (Opus 4.6 High) remains the default.
