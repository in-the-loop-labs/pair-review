---
"@in-the-loop-labs/pair-review": patch
---

Fix stack analysis ignoring a repo's configured worktree options. Per-PR worktrees created during a stack analysis now honor the repo's full worktree config instead of falling back to the defaults. This covers the `worktree_name_template` / `worktree_directory` naming and location (previously the default `{id}` naming and `~/.pair-review/worktrees`), and also threads through the repo's checkout script, checkout timeout, and sparse-checkout inheritance — matching the behavior of the non-stack PR setup path.

Also fix stack analysis under-reviewing files in monorepo sparse-checkout repos. Per-PR stack worktrees inherit the trigger worktree's sparse-checkout layout, but the stack setup path never expanded that cone to include the PR's changed directories. The stored diff was unaffected (it is computed from commit objects, not the working tree), but the file-context and codebase-context analysis steps read files from disk and could silently analyze an incomplete checkout. Stack setup now expands the sparse cone for the PR's directories before analysis — except when a `checkout_script` is configured, in which case the script remains the sole owner of sparse-checkout setup (matching the non-stack path).
