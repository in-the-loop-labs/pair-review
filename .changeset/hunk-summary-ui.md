---
"@in-the-loop-labs/pair-review": minor
---

Render semantic hunk summaries inline in the diff (gated behind `summaries_enabled`). Each non-trivial hunk gains a one-line natural-language annotation immediately above its first code row, fetched from `GET /api/reviews/:reviewId/hunk-summaries` on load and updated live via the `review:hunk_summaries_ready` WebSocket event. A toolbar button toggles every annotation at once (persisted per-review in localStorage), and a per-file header button toggles annotations for that file (also persisted per-review). Works in both PR and Local mode.
