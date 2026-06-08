---
"@in-the-loop-labs/pair-review": patch
---

Fix false "No tour to generate" / "No summary to generate" in local mode. The manual **Start guided tour** and **Generate summaries** buttons reported `no-diff` for local reviews that clearly had changes, because the manual job-start handler read the diff only from the `local_diffs` table — and several paths created/analyzed a local review without ever writing that table (the analysis-push, council, and MCP-analyze flows cached the diff in memory only or in `analysis_runs`).

Two complementary fixes:

- The local manual job-start handler now resolves the diff through the same chain the rest of local mode uses — in-memory cache → persisted `local_diffs` row → regenerate from the live working tree (scope-aware) — and persists the regenerated diff. It only reports `no-diff` when the working tree genuinely has no changes in scope, and self-heals reviews created before this fix. The working-tree regeneration is now gated by the same HEAD-snapshot guard as `refresh-diff`: for a non-branch review whose HEAD has moved off its recorded `local_head_sha`, regeneration is skipped and the user is funneled through the explicit `resolve-head-change` flow instead of silently re-snapshotting the moved HEAD onto a pinned review. Branch-scoped reviews (which persist across HEAD changes) keep regenerating as before.
- The analysis-push (`POST /api/analyses/results`), local council, and MCP `start_analysis` (local) paths now durably persist the diff to `local_diffs`, so the diff survives a restart regardless of which path created the review. Each path persists using the review's recorded scope (`unstaged`/`staged`/`branch`) rather than the default-scope wrapper, so re-using a review that was moved to a different scope no longer overwrites its durable row with a narrower patch, and the MCP path also refreshes the in-memory diff cache alongside the database row.

PR mode is unaffected: a PR's diff is always persisted in `pr_data` at load time, so its `no-diff` cannot be a false negative.
