---
"@in-the-loop-labs/pair-review": patch
---

Prune stale remote-tracking refs during pool worktree fetches to prevent ref hierarchy conflicts from blocking git fetch. Also reset dirty pool worktrees before refresh so unattended leftover state doesn't cause failures.
