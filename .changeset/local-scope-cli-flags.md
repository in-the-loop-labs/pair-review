---
"@in-the-loop-labs/pair-review": minor
---

Add `--scope` and `--base` CLI options for local reviews. `--scope <start>..<end>`
sets which changes a local review covers, using the same scope model as the web
UI — the ordered stops `branch`, `staged`, `unstaged`, `untracked`, restricted to
the six contiguous ranges that include `unstaged` (default `unstaged..untracked`).
`branch..*` scopes diff from the merge-base with the base branch, and `--base
<branch>` overrides base-branch auto-detection (Graphite state → GitHub PR base →
origin default branch → main/master). Both flags are local-mode only. An explicit
`--scope` is persisted on the review session, so reopening the review in the web UI
shows the same scope.

The `pair-loop` skill is updated to use `--scope branch..untracked` when the loop
commits work between rounds (or the reviewed work already spans commits on a
branch), so each review round covers the whole branch instead of an empty working
tree.
