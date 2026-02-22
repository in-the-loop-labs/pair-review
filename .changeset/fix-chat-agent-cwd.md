---
"@in-the-loop-labs/pair-review": patch
---

Fix chat agent CWD to use the review's worktree directory instead of the server's working directory. For PR reviews, the worktree path is now resolved from the worktrees table (matching analysis behavior). Previously, the chat agent could not explore the codebase in PR mode because it launched in the wrong directory.
