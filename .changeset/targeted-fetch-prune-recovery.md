---
"@in-the-loop-labs/pair-review": patch
---

Use targeted base-branch fetches with automatic prune recovery when creating and refreshing PR worktrees.

Refreshing a PR no longer runs a bulk `git fetch --prune <remote>`; both worktree creation and refresh now fetch only the PR's base branch. If that fetch hits a ref hierarchy conflict (a stale remote-tracking ref blocking a new one), stale refs are pruned with `git remote prune` and the fetch is retried once — this replaces a retry with `--force` that could never fix the conflict and swallowed the underlying error message.

Because the bulk fetch is gone for everyone, `skip_bulk_fetch` no longer affects the foreground refresh path; it now governs the background worktree pool fetch loop.
