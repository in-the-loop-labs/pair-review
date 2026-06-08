# Fix: "No tour to generate" in local mode when changes clearly exist

## Context

A user testing **local mode** clicked the manual **Start guided tour** button and got a
`No tour to generate.` toast even though the review had real changes. The same gap affects
the manual **Generate summaries** button (same handler).

### Root cause (confirmed against the live DB)

The toast fires when the server returns `{ started: false, reason: 'no-diff' }`
(`public/js/pr.js:1841-1842`). In local mode that response comes from the manual job-start
handler, which resolves the diff from the **`local_diffs` table only**:

```js
// src/routes/local.js ~2400  (POST /api/local/:reviewId/jobs/:jobKey/start)
const localDiff = await reviewRepo.getLocalDiff(reviewId);   // local_diffs table ONLY
const diffText = localDiff ? (localDiff.diff || '') : '';
const worktreePath = review.local_path || null;
if (!diffText || !worktreePath) return res.json({ started: false, reason: 'no-diff' });
```

But several paths create/analyze a local review **without ever writing `local_diffs`**:

| Path | Diff stored in | Writes `local_diffs`? |
|------|----------------|-----------------------|
| `POST /api/local/start` (`local.js:514`) | in-memory Map **+** DB | ✅ |
| CLI `setupLocalReviewSession` (`local-review.js:834`) | in-memory Map **+** DB | ✅ |
| Analysis push `analyses.js:236` | in-memory Map **only** | ❌ |
| Council `local.js:2279` | in-memory Map **only** | ❌ |
| MCP analyze `mcp.js` (local mode) | `analysis_runs.diff` only | ❌ |

Verified: the most recent local review (#727, branch `github-alt`) had a real **89,936-char**
diff (analyzed by a council + three `pi` runs) but **zero rows in `local_diffs`** → tour
button reads empty → false "no-diff".

The *auto-kickoff* path (`local.js:766`) does not hit this because it falls back through
in-memory → DB — but it only runs when `auto_generate` is **on**, i.e. never when the manual
button is in use.

### Intended outcome

The manual tour/summary buttons must never report "no-diff" when the working tree has changes,
and a local review's diff must be durably persisted regardless of which path created it.

---

## Approach (two complementary fixes)

### Fix A — Manual job-start handler self-heals (`src/routes/local.js`)

In the local manual-start handler (`POST /api/local/:reviewId/jobs/:jobKey/start`, ~line 2400),
replace the DB-only read with the same resolution chain the rest of the file already uses:

1. **In-memory cache** — `getLocalReviewDiff(reviewId)?.diff` (module helper, `local.js:73`).
2. **Persisted DB** — `reviewRepo.getLocalDiff(reviewId)`.
3. **Regenerate from the working tree** (scope-aware) when both are empty and `local_path`
   exists — using the already-imported `reviewScope(review)`, `generateScopedDiff(worktreePath,
   scopeStart, scopeEnd, review.local_base_branch)` and `computeScopedDigest(...)` (same calls as
   `local.js:1714`, `1980`, `2277`). On success, persist via `setLocalReviewDiff` **and**
   `reviewRepo.saveLocalDiff` so the next read is fast and durable. Wrap regen in `try/catch`
   (mirror the council block at `local.js:2276-2282`): on error, log via `logger.warn` and leave
   the diff empty.

Only return `{ started: false, reason: 'no-diff' }` when, after all three steps, the diff is
still empty (genuinely no changes in scope) or `local_path` is missing. This makes the tour
reflect the **current** working tree and self-heals reviews created before Fix B (incl. #727).

> All helpers (`getLocalReviewDiff`/`setLocalReviewDiff`, `reviewScope`, `generateScopedDiff`,
> `computeScopedDigest`) are already in scope in `local.js` — no new imports.

### Fix B — Persist the diff at the source (root cause)

Add a durable `saveLocalDiff` to the three paths that currently skip it:

1. **`src/routes/analyses.js` (after line 236)** — `generateLocalDiff` + `computeLocalDiffDigest`
   are already imported and `reviewRepo` exists (line 210). After
   `localReviewDiffs.set(reviewId, {...})`, add
   `await reviewRepo.saveLocalDiff(reviewId, { diff: diffResult.diff, stats: diffResult.stats, digest })`
   inside the existing `try`.

2. **`src/routes/local.js` council endpoint (~line 2276-2282)** — hoist `diff/stats/digest` into
   variables declared before the `try`, then after `reviewRepo` is constructed (line 2286) call
   `await reviewRepo.saveLocalDiff(reviewId, {...})` when a diff was produced. Keep the existing
   `setLocalReviewDiff` call.

3. **`src/routes/mcp.js` local-analysis branch (after the review is found/created, ~line 541)** —
   add imports for `generateLocalDiff` and `computeLocalDiffDigest` from `../local-review`
   (currently only `getCurrentBranch` is imported, line 14). Generate the diff and call
   `await reviewRepo.saveLocalDiff(reviewId, {...})` so the MCP-driven web UI can display the diff
   and the manual buttons work after a restart. Wrap in `try/catch` + `logger.warn` (non-fatal),
   matching `analyses.js:237-239`.

### PR mode — not affected (documented, not changed)

PR mode's diff is always persisted in `pr_data` at PR-load time, so `pr.js:813`
(`extendedData.diff`) cannot exhibit this bug — a PR `no-diff` correctly means `pr_data` has no
diff (no in-memory/regeneration equivalent exists). Add a one-line clarifying comment in the PR
handler; no behavioral change. (Noting this explicitly to satisfy the both-modes-parity rule:
the asymmetry is intentional because PR mode has no unpersisted-diff path.)

---

## Files to change

- `src/routes/local.js` — Fix A (manual-start handler) + Fix B #2 (council persistence).
- `src/routes/analyses.js` — Fix B #1.
- `src/routes/mcp.js` — Fix B #3 (+ 2 new imports).
- `src/routes/pr.js` — clarifying comment only.
- Tests (below).
- `.changeset/*.md` — new `patch` changeset for `@in-the-loop-labs/pair-review`
  ("Fix false 'No tour/summary to generate' in local mode when the diff was never persisted").

## Tests (mandatory — both happy path and regression)

- **`tests/integration/manual-start-jobs.test.js`**
  - Add: local review with **no `local_diffs` row** but a **real temp git repo with changes** →
    handler regenerates → `{ started: true }` and `kickOffTourJob` called (regression for the
    reported bug). Reuse the temp-git-repo fixture pattern from
    `tests/integration/review-file-content.test.js` / `tests/unit/local-review.test.js`.
  - Add: local review with an **in-memory diff but no DB row** (seed via `setLocalReviewDiff`
    through a route, or assert via the regen path) → `{ started: true }`.
  - Keep/clarify the existing "no-diff" case (`line 234`) so it uses a worktree with **no
    changes** (e.g. the non-existent `/mock/repo` still throws in regen → caught → `no-diff`),
    confirming the toast still appears when there genuinely is nothing to review.
- **`tests/integration/local-sessions.test.js`** (or `council-routes.test.js`) — after a council
  analysis on a local path, assert `getLocalDiff(reviewId)` returns the diff (Fix B #2).
- **`tests/integration/mcp-routes.test.js`** — after a local MCP analyze, assert a `local_diffs`
  row is written (Fix B #3).
- Locate the analyses-push test home (extend `local-sessions.test.js` if none) — assert a local
  analysis push writes `local_diffs` (Fix B #1).

## Verification

1. `pnpm test tests/integration/manual-start-jobs.test.js tests/integration/local-sessions.test.js tests/integration/mcp-routes.test.js`
2. Full `pnpm test` (Node 24 — do **not** rebuild better-sqlite3 under Node 22).
3. Frontend touch is toast-only/none, but run E2E via a Task agent per project rules:
   `pnpm run test:e2e` (headless).
4. Manual sanity: in local mode with `tours.auto_generate=false`, on a review created via an
   MCP/analysis flow (no `local_diffs` row), click **Start guided tour** → it should start
   generation (pulsing button), not show "No tour to generate".

## Hazards

- **`getLocalDiff` has many callers** (`local.js:768,909,972,1089`, `manual-start` handler,
  `local-sessions` tests). Fix A only changes the manual-start handler; other readers keep the
  in-memory→DB pattern they already have.
- **`saveLocalDiff` uses `INSERT OR REPLACE`** keyed by `review_id` — adding it to the
  analyses/council/mcp paths is idempotent and cannot create duplicates.
- **Council diff block ordering**: `reviewRepo` is constructed *after* the diff `try` block
  (`local.js:2286`); Fix B #2 must hoist the diff vars or move the save below that line.
- **Regen reflects the live working tree**, which may differ from the diff the user is viewing
  if the cache is stale. This is the desired behavior for a freshly-triggered tour and matches
  what `GET .../diff?w=1` / scope endpoints already do; the digest-based dedup in
  `kickOffTourJob`/`kickOffSummaryJob` handles cancel-and-restart on diff change.
- **Existing "no-diff" test** at `manual-start-jobs.test.js:234` asserts current behavior using
  `/mock/repo`; regen will throw there and be caught, so it still yields `no-diff` — but the
  test's intent should be re-documented as "no changes in scope".
