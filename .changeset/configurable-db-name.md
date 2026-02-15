---
"@in-the-loop-labs/pair-review": minor
---

Add configurable database names for per-worktree isolation. Set `db_name` in config or `PAIR_REVIEW_DB_NAME` env var to use a custom database file, preventing schema conflicts when switching branches during development. Also supports local `.pair-review/config.json` overrides.
