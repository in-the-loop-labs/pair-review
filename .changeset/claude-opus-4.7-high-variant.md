---
"@in-the-loop-labs/pair-review": patch
---

Add Claude Opus 4.7 High variant and normalize XHigh display name

- New `opus-4.7-high` model — Opus 4.7 pinned to `claude-opus-4-7` with
  `CLAUDE_CODE_EFFORT_LEVEL=high`, parallel to the existing `opus-4.7-xhigh`.
- Renamed the `opus-4.7-xhigh` display name from `Opus 4.7 xhigh` to
  `Opus 4.7 XHigh` for consistency with the Codex provider's `XHigh` casing
  and the existing `High`/`Low`/`Medium` capitalization on 4.6 variants.
