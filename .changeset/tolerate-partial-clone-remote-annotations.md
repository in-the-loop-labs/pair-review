---
"@in-the-loop-labs/pair-review": patch
---

Fix worktree remote resolution on partial clones. `git remote -v` appends the object filter (e.g. `[blob:none]`) to a partial-clone remote's fetch line, which caused those remotes to be ignored when matching the PR's base repository. The fallback then fetched from an unrelated remote that might not carry the PR's objects.
