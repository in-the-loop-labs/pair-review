# Diff Endpoint Performance — Parse Once + Cache Hunk Hashes (deferred follow-up)

Deferred follow-up to the frontend lazy-render work
([lazy-diff-body-rendering.md](lazy-diff-body-rendering.md)). Captured for a later change; **not**
yet implemented.

## Context

The frontend lazy-render fix addresses the dominant large-PR cost (rendering + highlighting every
file on load). This plan addresses the secondary, backend-side cost: the `/diff` endpoint re-does
heavy work on **every** request for a multi-MB diff. On a 303-file / 350+ translation-file PR this
is real latency on each diff fetch (initial load, whitespace toggle, scope change).

## Problem (verified)

In `src/routes/pr.js`, GET `/api/pr/:owner/:repo/:number/diff` (~966-1109) and the Local-mode
equivalent (`src/routes/local.js`):

- The full unified diff is parsed **twice** per request — `mergeChangedFilesWithDiff`
  (`src/utils/diff-file-list.js`) and `attachHunkHashes` → `computeHunkHashesFromDiff`
  (`src/routes/pr.js:78-88`) both call `parseUnifiedDiffPatches`.
- `computeHunkHashesFromDiff` recomputes a **SHA-256 per hunk** (`src/routes/pr.js:84`) — thousands
  of hashes — on every request, although the canonical diff is immutable for a given head SHA.
- The whole `{ diff, changed_files }` blob is stored as one JSON `TEXT` cell
  (`src/setup/pr-setup.js:91`; schema `src/database.js` `pr_metadata.pr_data`) and re-parsed from
  SQLite on each request.
- `?w=1` re-shells `git diff -w` and re-parses on top (`src/routes/pr.js:1013-1049`).

## Fix

1. **Parse once per request.** Parse `parseUnifiedDiffPatches(diff)` a single time and share the
   resulting patch map between `mergeChangedFilesWithDiff` and hunk hashing (pass the map in rather
   than re-deriving it).
2. **Cache hunk hashes at store time.** Compute `hunk_hashes` once in `storePRData`
   (`src/setup/pr-setup.js`) and persist them on each `changed_files` entry so the diff endpoint
   reads them instead of recomputing. Mirror in the Local setup path (`src/local-review.js` CLI
   entry and `src/routes/local.js` web-UI entry).
3. **Optional.** Memoize the whitespace-filtered diff per head SHA so `?w=1` doesn't re-shell git
   on each toggle.

## Hazards

- **Both PR and Local setup entry points must cache hashes** — CLI vs web-UI parity (CLAUDE.md:
  local sessions are created in `src/local-review.js` (CLI) and `src/routes/local.js` (web UI);
  cross-cutting behavior must fire from both).
- Hashes are keyed to the **canonical** (non-`-w`) diff — preserve that invariant. `renderPatch`
  already fails closed on hunk-count drift under `?w=1` (`public/js/pr.js:3266`), so stale/missing
  hashes degrade to "summary doesn't anchor" rather than "anchors to wrong hunk".
- Add/extend tests around `_computeHunkHashesFromDiff` / `_attachHunkHashes` (exported at
  `src/routes/pr.js:112-113`) and the store path.
- If `changed_files` now carries `hunk_hashes` from store time, the endpoint should prefer the
  stored value and only recompute as a fallback (e.g. older cached PR data without hashes).

## Verification

- `pnpm test` — unit + integration; add a regression test asserting the endpoint does not recompute
  hashes when they're present on `changed_files`, and that stored hashes match a fresh compute.
- Manual: load a large PR, confirm the second `/diff` request (e.g. whitespace toggle) is markedly
  faster; confirm hunk summaries still anchor on a small PR.

## Changeset

`patch` — internal performance, no API/behavior change.
