---
"@in-the-loop-labs/pair-review": minor
---

GitHub PR review-comment integration is now opt-in via a new `external_comments` flag in `~/.pair-review/config.json`. Defaults to `false`. When enabled, the **External** segment, the refresh button, the background sync, and the `/api/reviews/*/external-comments*` endpoints all light up. When disabled (the new default), they are completely absent — no UI, no requests, no routes mounted.
