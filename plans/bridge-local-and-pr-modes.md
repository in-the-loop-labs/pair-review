# Plan: Bridge Local Mode with Associated PR Features

## Context

Pair-review has two parallel implementations: local mode (`/local/:reviewId`) and PR mode (`/pr/:owner/:repo/:number`). They share a `reviews` table and comments table, but route handlers, frontend managers, and feature surfaces are duplicated. `LocalManager` patches `PRManager` methods on the frontend — workable but brittle.

We adopted **Option A**: when a local branch has an associated GitHub PR, layer PR features onto local mode.

We are **not** doing Option B (full unification, ~5-8 weeks). But Option A **seeds Phase 2 of Option B** by extracting shared backend logic into provider functions both routes call — rather than growing the frontend `LocalManager.patches(PRManager)` pattern.

## Design principles

1. **No new `LocalManager.patches(PRManager)`.** Shared backend logic goes into `src/providers/`. Both `routes/local.js` and `routes/pr.js` call providers; frontend reads results and renders.
2. **Detection persists in association columns, NOT the PR natural key.** Local rows store `associated_pr_number` + `associated_pr_repository` (added by migration 56). The PR natural key (`pr_number`, `repository`) stays exclusive to `review_type='pr'` rows. `getReviewByPR` is filtered to `review_type='pr'` for defense in depth.
3. **Capability flags are split into prerequisite state and action contracts.** `/api/local/:reviewId` returns:
   ```
   capabilities: {
     // Prerequisite state — true when conditions met
     hasAssociatedPR: boolean,
     hasGitHubToken: boolean,
     // Action contracts — hard-false in local mode until each phase ships
     canShowPRMetadata: boolean,   // Phase 1 flips
     canViewPRComments: boolean,   // Phase 2 flips
     canCheckStaleVsPR: boolean,   // Phase 3 flips
     canSyncDrafts: boolean,       // Phase 4 flips
     canSubmitToGitHub: boolean,   // Phase 5 flips
   }
   ```
   `PRManager` mirrors this surface with `hasCapability(name)`. In PR mode, action flags default `true` (the endpoints already ship in PR mode). In local mode, action flags only flip true as each phase wires the endpoint+UI end-to-end. **No mode-sniffing** — capability checks only.
4. **Local + PR parity preserved.** Every PR feature ported must continue to work in pure PR mode. Provider extraction is a refactor, not a rewrite. Every refactor phase must keep pure PR-mode tests green.

## Phases

### Phase 0: Foundation — SHIPPED (commit `dd7a505b`)

**Goal:** Persist PR association, expose capability flags, scaffold shared providers.

**What shipped:**
- Migration 47 adds `associated_pr_number INTEGER` + `associated_pr_repository TEXT` to `reviews`. Partial index `idx_reviews_associated_pr` scoped to `review_type='local'`. Backfill moves any prior Phase-0 writes from `pr_number`/`repository` into the new columns. Idempotent.
- `getReviewByPR` filtered to `review_type='pr'`. 8 callers audited (`getOrCreate`, `upsertCustomInstructions`, `upsertSummary`, `routes/config.js`, `routes/pr.js` x3, `routes/mcp.js` x2) — all expect PR rows.
- `ReviewRepository.associatePR(id, {prNumber, repository})` writes to `associated_pr_*` only when `associated_pr_number IS NULL AND review_type='local'`. Race-safe.
- `detectPRForBranch(repoPath, branch, {repository, githubToken, enableGraphite}, _deps)` extracted in `src/local-review.js` — guard-free (no diff/untracked checks). Called from 3 sites: CLI `handleLocalReview`, web UI `POST /api/local/start`, GET backfill in `routes/local.js`. Graphite enrichment via `tryGitHubPR` after Graphite-derived base branch.
- `src/providers/pr-context.js`: `getAssociatedPR`, `getPRContext`, `buildCapabilities`, `splitRepository`. DI pattern (`defaults + _deps`).
- `routes/local.js`: `GET /api/local/:reviewId` returns `capabilities` + `associatedPR: { prNumber, repository }`. Uses `req.app.get('githubToken')` — no re-resolve. Background backfill uses `detectPRForBranch` + per-process negative cache (5-min TTL) keyed on `${repository}:${branch}`.
- `public/js/pr.js`: `PRManager.capabilities` + `hasCapability(name)`. Action flags default `true` for PR mode (the endpoints exist there).
- `public/js/local.js`: `LocalManager.capabilities` populated from API response. Action flags default `false`.
- `public/js/components/SplitButton.js`: migrated from `window.PAIR_REVIEW_LOCAL_MODE` mode-sniff to `prManager.hasCapability('canSubmitToGitHub')` with legacy fallback. Contract validated end-to-end.

**Tests added:**
- `tests/unit/pr-context.test.js` — splitRepository edges, capability truth table, getAssociatedPR/getPRContext.
- `tests/unit/local-routes-cache.test.js` — negative-cache TTL.
- `tests/integration/review-repository.test.js` — real SQL: associatePR race guard, integer validation, `review_type='local'` filter, cross-mode `getReviewByPR` isolation.
- `tests/unit/local-review.test.js` — `detectPRForBranch` happy path, clean/dirty tree, Graphite enrichment, persistence errors.
- `tests/integration/routes.test.js` — capabilities response shape.

Changeset: `.changeset/local-pr-association-capabilities.md` (`minor`).

### Phase 1: PR metadata display

**Goal:** When local review has `hasAssociatedPR`, show PR link, title, author in header.

Files:
- `src/providers/pr-context.js` — add `fetchPRMetadata(owner, repo, prNumber, token, _deps)` returning `{ title, author, url, state, head_sha }`. Cache in existing `pr_metadata` table.
- `src/routes/local.js` — include cached PR metadata in `/api/local/:reviewId` response when `hasAssociatedPR`. Flip `capabilities.canShowPRMetadata` to `true` in `buildCapabilities` for local mode when metadata is reachable.
- `public/js/local.js` — render PR badge/link in header when `hasCapability('canShowPRMetadata')`.
- `public/css/*.css` — small style for PR badge in local header.
- README update if user-visible.

Tests:
- Unit: `fetchPRMetadata` caches and returns from cache on second call.
- Integration: metadata appears in API response when `associated_pr_*` are populated.
- E2E: local review with associated PR shows PR link in header.

Changeset: `minor` — "Show associated PR metadata in local reviews."

### Phase 2: Inline existing PR comments (read-only)

**Goal:** Fetch comments already on the PR and show alongside local drafts.

Files:
- `src/providers/pr-comments.js` (NEW) — extract from `src/routes/pr.js` `refresh` handler (lines 328-515) and `comments.js`. `fetchPRComments(owner, repo, prNumber, token, _deps)` returns normalized comments.
- `src/routes/pr.js` — refactor existing comment-fetch path to call provider.
- `src/routes/local.js` — new endpoint `GET /api/local/:reviewId/pr-comments`. Gate on `hasAssociatedPR`. Flip `canViewPRComments` to `true` in `buildCapabilities` for local mode.
- `public/js/local.js` — fetch and render PR comments inline with read-only badge.

Tests:
- Unit: provider normalizes comments correctly.
- Integration: endpoint returns 404 when no associated PR; returns comments when associated.
- E2E: PR comments visible inline in local mode.
- Regression: pure PR-mode comments path still works.

Changeset: `minor` — "Show existing PR review comments inline in local mode."

### Phase 3: Stale detection vs PR head

**Goal:** Local stale check also compares against PR `head_sha`.

Files:
- `src/providers/stale-check.js` (NEW) — extract from `src/routes/local.js` `check-stale` and `src/routes/pr.js` `check-stale`. `checkStale({ reviewId, includePRHead }, _deps)` returns `{ isStale, reasons: [...] }`.
- `src/routes/local.js` `check-stale` — when `hasAssociatedPR`, also compare local HEAD vs PR `head_sha`. Flip `canCheckStaleVsPR` to `true`.
- `src/routes/pr.js` `check-stale` — refactored to call same provider (parity).
- `public/js/local.js` / `pr.js` — surface new reason ("PR has new commits") in stale UI.

Tests:
- Unit: provider returns combined reasons.
- Integration: both routes' `check-stale` produce equivalent results for equivalent inputs.
- Regression: pure PR-mode stale check unchanged.

Changeset: `patch` — "Detect PR head drift in local stale check."

### Phase 4: Pending draft sync

**Goal:** Pull drafts started in GitHub UI into the local session.

Files:
- `src/providers/draft-sync.js` (NEW) — extract `syncPendingDraftFromGitHub` (`src/routes/pr.js:76-151`) into provider.
- `src/routes/pr.js` — refactor existing call site to use provider.
- `src/routes/local.js` — new endpoint `POST /api/local/:reviewId/sync-drafts` gated on `hasAssociatedPR`. Flip `canSyncDrafts` to `true`.
- `public/js/local.js` — sync button visible when `hasCapability('canSyncDrafts')`; refreshes comment list on success.

Tests:
- Unit: provider merges remote drafts into DB without dup.
- Integration: endpoint 403 when no PR; success when associated.
- E2E: sync button shows and works in local-with-PR.
- Regression: pure PR-mode draft sync unchanged.

Changeset: `minor` — "Sync GitHub pending drafts into local reviews."

### Phase 5: Submit review to GitHub (highest risk — writes to GitHub)

**Goal:** Submit local-mode review as a real GitHub review.

**Two-step refactor:**
- 5a: Extract `src/providers/review-submit.js` — `submitReview({ reviewId, body, event, comments, token }, _deps)` from `routes/pr.js:1067-1356`. PR route calls it identically. Ship + verify pure PR-mode regression.
- 5b: Wire local route.

Files:
- `src/providers/review-submit.js` (NEW).
- `src/routes/pr.js` `submit-review` — refactor to use provider.
- `src/routes/local.js` — new endpoint `POST /api/local/:reviewId/submit-review`. Pre-checks: `hasAssociatedPR`, local HEAD matches PR `head_sha` (HARD REFUSE on drift — no force override in v1), PR still open. Flip `canSubmitToGitHub` to `true`.
- `public/js/local.js` — submit UI gated on `hasCapability('canSubmitToGitHub')`. On HEAD drift, show clear error explaining user must push/pull to align before submitting.

Tests:
- Unit: provider handles each `event` type.
- Integration: route returns 409 on HEAD drift; returns 410 on closed PR.
- E2E: full local-with-PR submit flow (mocked GitHub).
- Regression: pure PR-mode submit unchanged.

Changeset: `minor` — "Submit local reviews to GitHub when PR is associated."

## Hazards

**Shared functions modified or to-be-modified (list every caller before changing):**
- `detectPRForBranch` (`src/local-review.js`, post-Phase-0) — callers: (1) CLI `handleLocalReview`, (2) web UI `POST /api/local/start`, (3) `GET /api/local/:reviewId` background backfill. Any signature change must touch all three.
- `detectAndBuildBranchInfo` (`src/local-review.js`) — still used for CLI scope-suggestion UX. Does NOT do PR persistence anymore; that moved to `detectPRForBranch`.
- `getReviewByPR` (`src/database.js`) — filtered to `review_type='pr'`. 8 callers; all expect PR rows. Do not relax the filter.
- `check-stale` endpoints in BOTH `src/routes/local.js` AND `src/routes/pr.js`. Phase 3 refactor must produce identical outputs for the existing inputs.
- `syncPendingDraftFromGitHub` (`src/routes/pr.js:76-151`) — currently called from PR refresh path. Phase 4 extraction must preserve refresh-time behavior.
- `submit-review` (`src/routes/pr.js:1067-1356`) — large handler with side effects (GitHub API write, DB updates, comment status transitions). Phase 5a/5b split required.
- `buildCapabilities` (`src/providers/pr-context.js`) — every phase flips one action flag. Forgetting to flip silently disables the feature with no error. Verify flag flips in each phase's integration test.

**Async races:**
- PR detection is async over GitHub API. If user refreshes mid-detection, `/api/local/:reviewId` may return `hasAssociatedPR: false` then `true` on next poll. Frontend must tolerate capability flags appearing later (re-render, don't latch).
- PR can be **closed** between session start and Phase 5 submit. Provider must check PR state at submit time, not at capability-flag time. Return 410 + clear error.
- PR `head_sha` can drift between Phase 3 stale check and Phase 5 submit. Submit provider must re-check at submit time and HARD REFUSE on mismatch.
- Branch rename on GitHub between detection and feature use — `associated_pr_number` persisted, but `associated_pr_repository` could be stale. Provider should re-resolve owner/repo on PR fetch, log if changed.
- Negative cache (5-min TTL, per-process) never invalidates on external state change. If user opens a PR mid-session, the cache will not reflect it for up to 5 min. Phase 1 may want explicit invalidation on manual refresh.

**State changing between scheduling and execution:**
- User may invalidate token between detection and submit. All providers must accept token via `_deps` (per CLAUDE.md DI rule) and surface auth errors clearly.
- Local row's `associated_pr_number` can be cleared if branch is later disassociated (force-pushed to unrelated history). Capability is recomputed each request — do not cache `hasAssociatedPR` on the frontend across navigation.

**Capability surface drift:**
- `PRManager.capabilities` defaults action flags to `true` (PR mode already supports them). `LocalManager.capabilities` defaults action flags to `false`. Each phase flips its local flag only — do NOT touch PRManager defaults.
- If a phase ships a feature in pure PR mode at the same time as local mode, both surfaces need flipping (but PR's is already `true`, so usually a no-op).

**Anti-pattern temptations:**
- Adding `LocalManager.patches(PRManager)` for each new capability. **Do not.** Backend logic goes in providers; frontend reads capability flags.
- Mode-sniffing via `window.location.pathname` or `window.PAIR_REVIEW_LOCAL_MODE`. Use `prManager.hasCapability(name)` only. (SplitButton.js was the first migration; more remain in `PreviewModal.js`, `AIPanel.js`, `DiffOptionsDropdown.js`, `pr.js`.)
- Re-resolving config (e.g., calling `getGitHubToken` again). Always use `req.app.get('githubToken')`.

**Parity rule (CLAUDE.md):**
- Every refactor in Phases 2-5 touches code that pure PR mode depends on. Each phase must keep pure PR-mode tests green. Do not ship a phase without a green pure-PR-mode test pass.

## Verification

For each phase:
- `pnpm test` — unit + integration green.
- `pnpm run test:e2e` — E2E green (use Task tool per CLAUDE.md).
- Manual: `npx pair-review --local` on a branch with an associated PR — capability appears, feature works.
- Manual: `npx pair-review --local` on a branch with NO associated PR — capability absent, feature hidden, no errors.
- Manual: `npx pair-review <PR-URL>` — pure PR mode unchanged (regression).
- README updated if the feature is user-visible (Phases 1, 2, 4, 5).

## Decisions (locked in)

1. **HEAD drift on submit (Phase 5):** Hard refuse on drift. No force override in v1. User pushes/pulls to align.
2. **PR detection polling cadence:** On session start + explicit refresh only. No auto-poll.
3. **`pr_metadata` table:** Exists in `src/database.js`. Phase 1 uses it.
4. **PR association columns:** Separate (`associated_pr_number`, `associated_pr_repository`) — not the PR natural key. Migration 47.
5. **Capability shape:** Split into prerequisite state + action contracts. Action flags hard-false in local mode until each phase ships.
6. **Background backfill caching:** Per-process Map, 5-min TTL. No external invalidation in Phase 0.
