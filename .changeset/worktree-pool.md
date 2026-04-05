---
"@in-the-loop-labs/pair-review": minor
---

Add configurable worktree pool for reusable git worktrees per repository

Instead of creating and destroying worktrees per PR review, pool worktrees persist and are switched between PRs via incremental fetch + checkout + reset_script. This amortizes the cost of git fetch and sparse-checkout setup for monorepos and large repositories.

New config keys under `repos.<owner/repo>`:
- `pool_size` — max pool worktrees for this repo (0 = disabled, current behavior)
- `reset_script` — command to run when switching a pool worktree to a new PR
- `pool_fetch_interval_minutes` — background fetch interval for idle pool worktrees

Also renames the `monorepos` config key to `repos` (old key still works as a silent fallback).
