---
"@in-the-loop-labs/pair-review": patch
---

Use targeted base-branch fetches with automatic prune recovery when creating and refreshing PR worktrees.

Refreshing a PR no longer runs a bulk `git fetch --prune <remote>`; worktree creation, update, and refresh all now fetch only the PR's base branch, and the PR-head fetch gets the same treatment. If a fetch hits a ref hierarchy conflict (a stale remote-tracking ref blocking a new one), stale refs are pruned with `git remote prune` and the fetch is retried once — this replaces a retry with `--force` that could never fix the conflict and swallowed the underlying error message. Transient ref lock-file races, which pruning cannot fix, are no longer mistaken for hierarchy conflicts.

PR payloads that carry the base branch only in nested REST form (`base.ref`) now get the targeted fetch too, instead of falling back to a direct SHA fetch that some Git servers reject.

A PR whose data carries no base branch at all — only a base SHA — now creates its worktree directly from that SHA instead of failing on an invalid `<remote>/null` start point. When neither a base branch nor a base SHA is present, the error names the PR instead of surfacing as an opaque git failure.

Because the bulk fetch is gone for everyone, `skip_bulk_fetch` no longer affects the foreground refresh path; it now governs the background worktree pool fetch loop.
