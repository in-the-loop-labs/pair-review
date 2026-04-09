---
"@in-the-loop-labs/pair-review": patch
---

Harden cross-instance pool fetch coordination: replace TOCTOU-prone check-then-claim with atomic SQLite UPSERT lease, add heartbeat refresh after each worktree fetch, normalize repo name casing to match database collation, and make migration 42 idempotent with exception-safe pragma handling.
