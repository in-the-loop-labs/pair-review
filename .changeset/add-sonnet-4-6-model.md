---
"@in-the-loop-labs/pair-review": patch
---

Add Sonnet 4.6 model to Claude provider and fix model definitions

- Add `sonnet-4.6` entry with pinned `cli_model: 'claude-sonnet-4-6'`
- Rename `sonnet` entry to `sonnet-4.5` with pinned `cli_model: 'claude-sonnet-4.5'`
- Move `opus-4.5` to end of model list so Opus 4.6 variants appear together
- Fix `opus-4.5` tier from `balanced` to `thorough`
- Fix `sonnet-4.5` badgeClass to `badge-balanced` to match its positioning
