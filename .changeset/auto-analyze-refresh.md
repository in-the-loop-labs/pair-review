---
"@in-the-loop-labs/pair-review": patch
---

fix: always refresh PR data before auto-analysis

When navigating to a PR with `?analyze=true` (e.g., from the review-requests skill or
batch operations), the worktree is now always refreshed before analysis begins. This
ensures AI analysis runs against the latest PR commits, not stale cached data from a
previous session.

Previously, if a worktree already existed for a PR, the auto-analyze flow would skip
the staleness check and analyze potentially outdated code without warning.
