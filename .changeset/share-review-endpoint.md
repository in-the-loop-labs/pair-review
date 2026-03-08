---
"@in-the-loop-labs/pair-review": minor
---

Add share endpoint for external review viewers

- New `/api/pr/:owner/:repo/:number/share` endpoint returns review data (PR metadata, AI analysis suggestions) for external consumption
- Configurable share button in the review UI via `~/.pair-review/config.json`:
  - `share.url`: External viewer URL (callback receives share endpoint URL)
  - `share.label`: Custom button label
  - `share.icon`: Custom icon (supports SVG, emoji)
  - `share.description`: Tooltip text
- Supports sharing specific analysis runs or falls back to most recently completed run
- Added `safeParseJson` utility to prevent malformed JSON from crashing endpoints
