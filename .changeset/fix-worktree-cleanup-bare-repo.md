---
"@in-the-loop-labs/pair-review": patch
---

Fix worktree cleanup failing when worktrees are outside the parent git repo directory (e.g., bare repo setups). Cleanup now resolves the owning repository via `git rev-parse --git-common-dir` instead of assuming the parent directory or `process.cwd()` is the correct repo.
