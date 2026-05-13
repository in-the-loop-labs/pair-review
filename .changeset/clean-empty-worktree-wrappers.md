---
"@in-the-loop-labs/pair-review": patch
---

Clean up empty wrapper directories left behind after deleting nested `src` worktrees.

When a worktree checkout is stored at `<worktreeBaseDir>/<id>/src`, deleting the git worktree removes `src` but can leave `<worktreeBaseDir>/<id>` behind as an empty ordinary directory. Pair Review now removes that wrapper only when it is inside the configured worktree base directory and empty.
