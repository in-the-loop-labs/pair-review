# Plan: Bridge Local Mode with Associated PR Features

## Context

Pair-review has two parallel implementations: local mode (`/local/:reviewId`) and PR mode (`/pr/:owner/:repo/:number`). They share a `reviews` table and comments table, but route handlers, frontend managers, and feature surfaces are duplicated. `LocalManager` patches `PRManager` methods on the frontend — workable but brittle.

We adopted **Option A**: when a local branch has an associated GitHub PR, layer PR features onto local mode.

We are **not** doing Option B (full unification, ~5-8 weeks). But Option A **seeds Phase 2 of Option B** by extracting shared backend logic into provider functions both routes call — rather than growing the frontend `LocalManager.patches(PRManager)` pattern.

## ⚠ AT REBASE TIME — renumber the migrations against main (decided 2026-08-23)

**This branch's migration numbers are PROVISIONAL. Renumber them to follow whatever `main` is at when this branch rebases, and bump `CURRENT_SCHEMA_VERSION` to match — before merging, never after.** As written the branch adds **56** (the PR-association columns, Phase 0) and **57** (the `github_reviews` dedupe plus its partial unique indexes, Phase 4) on top of a `main` that was at 55. If `main` has moved on, both numbers move with it. Re-run the migrations against a database already stamped at main's current version, not against a fresh one — a fresh database proves nothing here, because the failure only appears on an install that has already been stamped.

The deadline is not a style preference, it is mechanical. `runVersionedMigrations` (`src/database.js`) returns early on `currentVersion >= CURRENT_SCHEMA_VERSION` and then steps `currentVersion + 1 … CURRENT_SCHEMA_VERSION`. Once a user's database has been stamped with a number, any *other* migration later given that same number is permanently unreachable on that database — every existing install skips it in silence, and only brand-new databases ever get the change. Past that point a renumber alone stops being a fix: it takes a new repair migration that re-applies the skipped DDL idempotently, on top of the renumber.

This is the same rule that governs migrations on release branches, and the reason Phase 0's migration was itself renumbered from 47 to 56 during the v5.1.0 rebase (see Phase 0): **a migration number is claimed the moment a database is stamped with it, not the moment the code is written.** Ordering is decided by what users' databases have actually run, not by review order or merge intent — which is exactly why the renumber belongs to the rebase, where main's real state is in front of you.

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

### Phase 0: Foundation — SHIPPED (commit `8b90a9aa`)

**Goal:** Persist PR association, expose capability flags, scaffold shared providers.

**What shipped:**
- Migration 56 (renumbered from 47 during the v5.1.0 rebase — main had claimed 47-55) adds `associated_pr_number INTEGER` + `associated_pr_repository TEXT` to `reviews`. Partial index `idx_reviews_associated_pr` scoped to `review_type='local'`. Backfill moves any prior Phase-0 writes from `pr_number`/`repository` into the new columns. Idempotent.
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

### Phase 1: PR metadata display — SHIPPED (commit `5aad5a20`)

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

### Phase 2: Inline existing PR comments (read-only) — SHIPPED

**Goal:** A local review whose branch has an associated PR shows that PR's inline review comments in the diff, read-only, alongside local drafts.

#### What shipped

Everything below landed as designed, except where marked **Delta**.

- `resolveCommentTarget(review)` replaces `isPRMode` in `src/routes/external-comments.js`, exported for tests. `executeSync` routes all three former reads through it — including the `getPRHost` lookup, whose `Number.isInteger(review.pr_number)` guard would otherwise have silently skipped dual-host disambiguation for every associated PR (a local row's `pr_number` is NULL). Sync 400s / fetch returns `{threads: []}` on null, as specified.
- **Delta (new work the plan missed):** `ReviewRepository.getReview` did not SELECT the association columns, so the resolver saw `undefined` for every local review. Added `associated_pr_number, associated_pr_repository` to its SELECT — `external-comments.js`'s `validateReviewId` middleware is the caller that needs them.
- `buildCapabilities` → `canViewPRComments: Boolean(hasAssociatedPR && hasToken)`, deliberately independent of `prMetadataAvailable`.
- Anchor trust lives in `ExternalCommentManager` (`trustPreciseAnchors` + `setAnchorContext`), decided by `PRManager._externalAnchorContext()` comparing `currentPR.head_sha` against `currentPR.associatedPR.head_sha`. Degraded threads take the file zone with class `external-comment-row--anchor-degraded` and an `.external-comment-provenance` note. `LocalManager` mirrors `associatedPR` onto `currentPR` to make that comparison possible.
- **Delta — decision 8 needed a second gate.** Both operands of the head_sha comparison are page-load snapshots: local HEAD is cached on `currentPR` (and was never updated by `_applyRefreshedDiff`, now fixed), and the PR's `head_sha` comes from the TTL-less `pr_metadata` cache. A PR that advances mid-session therefore still looked like a match — the exact silent-wrong-anchor outcome decision 8 exists to prevent. Each stored comment already carries `commit_sha` / `original_commit_sha`, delivered fresh with the synced rows and cached nowhere, so `_anchorTrusted(comment, outdated)` additionally requires per-comment agreement with the commit the rendered diff IS (`anchorCommitSha`). Armed only in local mode; null in PR mode, which disarms it and leaves PR behaviour byte-identical. Outdated rows always degrade under the armed gate — intended, since their line numbers describe an older commit.
- **Delta — `syncAndRender` could silently skip its POST.** It shared `_inflight` with `loadAndRender` in both directions and returned a joined GET-only promise verbatim: no POST, no `syncResult`/`syncError`, so the caller fired no toast and the mirror was never synced. Latent in PR mode; Phase 2 makes it likely, because `_maybeWarmPRMetadata`'s GET-only re-render races `loadLocalReview`'s initial sync. `_inflightIsSync` now distinguishes the two — a sync joins only another sync, and CHAINS onto a GET-only load.
- **Delta — panel/diff count mismatch is routine in local mode.** The AI panel lists every fetched thread, but only files present in the rendered diff can hold a row; a scoped local review, or a PR comment on an untouched file, leaves panel rows that scroll nowhere. `AIPanel.scrollToExternalThread` toasted instead of silently doing nothing. **Superseded by the 2026-08-19 review round** (see below): the toast was the wrong terminal state — clicking an off-diff thread now adds a context file so the thread can anchor, and the toast survives only as the failure fallback.
- **Delta — capability floor.** `PRManager`'s constructor defaults every flag true (correct for PR mode). `LocalManager.patchPRManager` now pushes its all-false floor immediately, so a failed `loadLocalReview` can no longer leave a local page advertising `canSubmitToGitHub` / `canViewPRComments`.
- `pr.js:1204`'s local-mode bail became `hasCapability('canViewPRComments')`. Two new shared PRManager methods — `_prepareExternalCommentManager()` (reviewId + anchor context, used by both the sync and the GET-only path) and `_updateExternalCommentsAffordances()` (reveals the External segment + refresh button) — are called from BOTH modes.
- **Delta:** `AIPanel` cannot read the capability in its constructor — `window.prManager` is created in a later DOMContentLoaded handler, so it does not exist yet in either mode. The constructor now handles only the `externalDisabled` kill switch and exposes a dumb `setExternalSegmentVisible(visible)` that `_updateExternalCommentsAffordances` drives once flags land. Each page's static markup carries the correct pre-capability state (pr.html visible, local.html `hidden`), so nothing flashes and PR mode is untouched.
- **Delta:** local mode has no `_rerenderAllOverlays`; its overlay re-render is hand-duplicated at five `loadLocalDiff()` call sites. `LocalManager._renderExternalComments({sync})` was added and wired into all five, plus `_maybeWarmPRMetadata` — the only in-session path that can flip anchor trust, since it is what fetches the PR's `head_sha`.
- **Read-only audit result:** `ExternalCommentManager` has no reply/resolve/edit/dismiss control and makes exactly one network call (a GET). The chat buttons dispatch to the local chat panel; author link and permalink are `target="_blank"` navigations. Nothing needed suppressing for local mode.

**Test deltas:**
- `tests/unit/external-comments-{sync,fetch}.test.js` do not exist — there was no unit-level coverage of this route to extend. Added `tests/unit/external-comments-target.test.js` instead.
- `tests/unit/ai-panel-external-segment.test.js` did NOT assert "hidden in local mode"; its three hidden-button tests drive off `hasAttribute('hidden')` and were already correct. The real mode-sniff assertion was `tests/unit/pr-external-comments-wiring.test.js:187` — that is the one rewritten as a capability test. New constructor-level AIPanel tests were added, since that file's `Object.create` harness never ran the constructor.
- `tests/unit/pr-external-comments-wiring.test.js` needed a fixture fix: `createTestPRManager` used `Object.create` and so carried no `capabilities`, which the new gate reads.

Changeset: `.changeset/local-mode-external-pr-comments.md` (`minor`).

#### Review round (2026-08-19) — fixes applied

A review of the Phase 2 diff produced 14 findings. All were addressed in-branch except the two recorded as accepted deltas below.

**Correctness**

- **Dirty-tree capability deadlock (critical).** On the modal local session — uncommitted changes on a PR branch — the review row carried no association at first render (`detectAndBuildBranchInfo` bails on a truthy diff; the CLI's `detectPRForBranch` fallback only runs when the scope includes branch), so the client rendered with `hasAssociatedPR: false`. The one capability-refreshing call it made, `_maybeWarmPRMetadata`, was itself guarded on that flag — a self-sustaining deadlock that made the whole feature invisible until a manual reload, and that Refresh could not break either. `GET /api/local/:reviewId/pr-metadata` is now the capability-recovery endpoint: it runs `detectPRForBranch` inline (subject to the existing negative cache) when the freshly-read row still has no association, and returns recomputed capabilities. The frontend guard dropped to `hasGitHubToken`. The main GET deliberately does NOT block on detection — that would put a GitHub round trip on the first render of every local review, most of which have no PR.
- **Dual-host repos guessed github.com, then persisted the guess (high).** For a dual repo (`api_host` set, `exclusive: false`) `canViewPRComments` was true while `pr_metadata` could never gain a row, so `getPRHost` returned `undefined`, the ambiguity rule chose the github.com flavour, and the sync fetched an unrelated github.com PR #N and mirrored a stranger's comments onto the reviewer's code. The host is now derived from the local checkout's git remote — `parseRemoteUrl`/`getRemoteHostname` in `src/local-review.js` (the hostname `getRepositoryName` already parsed and discarded) plus `hostnameMatchesApiHost`/`remoteHostnameToHostOption` in `src/utils/host-resolution.js`, comparing hostnames rather than raw strings so an `api.` prefix or an `/api/v3` path still matches. `resolveRepositoryBinding` attempts that resolution before stamping `hostAmbiguous`, and a remote-derived host is evidence rather than a guess, so caching it is legitimate and everything downstream self-heals. PR mode keeps its existing probe — it learns the host from the URL and has no local checkout. **This supersedes the deferred ambiguous-binding issue for local mode.**
- **The PR head cache never refreshed.** `pr_metadata` has no TTL and was only written on a miss, so the ordinary workflow — review uncommitted work at PR head, commit, refresh — flipped anchor trust to false permanently, with every thread carrying a note claiming a commit mismatch that the PR had already caught up with. Fixed with an explicit refresh path rather than a TTL (a TTL has no correct value): `fetchPRMetadata({ forceRefresh })`, `?refresh=1` on the pr-metadata endpoint, and frontend triggers on both a moved local HEAD (the pull case) and any user-initiated refresh (the push case, where local HEAD does not move). The `hostAmbiguous` refusal stays in front of the forced fetch, so a forced refresh can never become a way to persist a guessed host.
- **LEFT-side anchors were ungated.** Both trust gates were head-side only, but LEFT-side line numbers come from the PR's *base* commit while the rendered diff's left side is the local merge-base, base override, or scope — on the default `unstaged..untracked` scope, not a merge-base at all. A LEFT thread therefore passed both gates whenever the heads agreed and anchored confidently onto a line from a different coordinate system: the "line found, wrong content" outcome decision 8 exists to prevent. A third gate now requires `scopeIncludesBranch && localMergeBase === prBaseSha`, plumbed through `mergeBaseSha`/`scopeIncludesBranch` on the local GET, refresh and set-scope responses and `base_sha` on the `associatedPR` payload. It rides the existing `_anchorTrusted` seam — now `_anchorDegradeReason`, returning `null | 'head' | 'base'` — so placement and provenance wording stay in lockstep, with distinct text that names the base rather than claiming a head mismatch.
- **Chat context bypassed the trust gate.** The "chat about this" buttons on a degraded card still shipped the raw PR-head coordinates, and ChatPanel quoted the *local* patch at those numbers and asserted `file.js:123-125` to the agent — the one surface feeding the AI got exactly the confident-and-wrong anchor the card had just disowned. Both entry points now gate the line numbers on the same predicate the placement used, pass `isFileLevel`, and carry the provenance sentence so the agent knows why the context is file-scoped.
- **The base-branch rebuild dropped two of three overlay layers.** It restored external comments only, while its four siblings restored user comments and AI suggestions too — under a comment claiming parity that did not hold. All four rebuild paths now route through `LocalManager._rerenderLocalOverlays({ sync })`, retiring the fourth hand-rolled copy of the sequence.
- **Adopting a refreshed HEAD wiped viewed state.** `head_sha` was half the local-mode viewed-state localStorage key, and a key miss hard-resets the set rather than leaving it alone — so any refresh across a moved HEAD silently cleared every checkmark, including on the silent-refresh path that runs on page load with zero interaction, and on the branch that had just promised "keep comments and suggestions". The key is now scoped to the review session with a read-through fallback to the legacy key. `updateLocalHeader` is also re-run after the adopt, so the toolbar SHA no longer diverges from the value the anchor check uses.
- **The refresh button's `hidden` attribute was inert.** `.findings-nav-btn`'s author-origin `display: flex` beat the UA `[hidden]` rule, so the button rendered in local mode without an associated PR — and did nothing, since `_loadExternalComments` bailed before any await. Added `.findings-nav-btn[hidden]`, matching the existing `.segment-btn[hidden]` / `.segment-scroll[hidden]` overrides, plus a capability guard on the handler so it agrees with the affordance policy. Unit tests could not have caught this: they assert `hasAttribute('hidden')` against a stub with no cascade, so the E2E block now asserts visibility.
- **The off-diff toast fired on every j/k keystroke and stacked.** `scrollToExternalThread` has two callers, and the positional-navigation one walks straight through threads whose files are not in the diff; `Toast.showToast` has no dedupe, so N off-diff threads meant N stacked toasts. Notification is now opt-in and passed only from the click path.

**New behaviour: off-diff threads add a context file**

A thread on a file the current scope does not render used to dead-end — dropped from the DOM, still counted in the panel, and on click a toast pointing at somewhere the reviewer could not go. But pair-review already has the mechanism for showing code outside the diff: context files render in the diff panel exactly like diff files, with a real wrapper and comment zone. The off-diff case was never an unrenderable state; it was an un-added context file.

Clicking an off-diff thread in the External segment now calls the existing `PRManager.ensureContextFile` (which dedupes by file and widens an overlapping stored range), re-renders external comments so the thread anchors into the new wrapper, and scrolls to it. Deliberately **on demand, click-path only** — adding one per off-diff thread at load would pull in a large number of files unprompted, and positional j/k navigation must stay silent per the toast fix above. The toast survives only as the failure fallback: file deleted upstream, outside the repo, or the request failed.

**Accepted deltas (recorded, not fixed)**

1. **The panel advertises a precise line for threads the diff renders at file level.** The degradation decision is made inside `ExternalCommentManager` and never stamped back onto the thread object, so `getAllThreads()`/`_notifyPanel` hand AIPanel the raw server rows: `renderExternalThreadItem` still derives `isFileLevel` from `thread.is_file_level` alone and renders `utils.js:42`, and `sortItemsByFileOrder` files it among the line comments instead of with the file-level ones. So the External segment states a line number the inline card's provenance note explicitly disowns, and panel ordering diverges from the diff. Navigation is unaffected (`scrollToExternalThread` matches on `data-thread-id`), which is why this stays cosmetic — but degraded is the common case in local mode and the panel is the primary discovery surface, so the most-read surface is the inaccurate one. When picked up, the fix is small: `_anchorDegradeReason` is pure given the anchor context, so the flag can be stamped in `_notifyPanel` without depending on render order, and the panel can then render file-level and sort with the file-level items. Precedent exists — it already renders an `outdated` badge from `thread.is_outdated`.
2. **Uncommitted working-tree edits at a matching `HEAD` still shift lines.** Unchanged from decision 8: the gates compare commits, not contents. This is the feature's primary use case, so it is the residual that matters most; content-based re-anchoring is the real fix and would subsume the head gate entirely.

**Test-harness corrections**

- `tests/e2e/global-setup.js` is dead code — `playwright.config.js` declares no `globalSetup` and no `webServer`, and `fixtures.js` spins a per-worker server from `test-server.js`. The duplicate `LOCAL_PR_REVIEW` fixture added there was reverted rather than kept in sync by hand. Whether that file should be deleted outright or wired back in is a separate decision; CLAUDE.md still instructs contributors to mirror schema into it.
- `tests/e2e/test-server.js` now states `external_comments: true` in both the effective config and the raw config layer. Runtime config treats only a literal `false` as disabled, so the associated-PR specs had been passing by omission rather than by exercising the production opt-in.

#### Reality check (recon 2026-08-13 — supersedes the original sketch)

The original Phase 2 said "extract `src/providers/pr-comments.js` from `routes/pr.js:328-515` + `comments.js`". That is wrong on every count:

- `src/routes/comments.js` does not exist.
- `routes/pr.js:328-515` is now inside the `GET /api/pr/:owner/:repo/:number` handler (`:303`); refresh moved to `:530`.
- **The feature already exists, and it is already review-scoped rather than PR-route-scoped.** `src/routes/external-comments.js` serves `POST`/`GET /api/reviews/:reviewId/external-comments[/sync]`, backed by `src/external/github-adapter.js`, `ExternalCommentRepository`, and `public/js/modules/external-comment-manager.js` (singleton `window.externalCommentManager`, `.external-comment-row`, AI-panel "External" segment).

So there is **no provider to extract**. Phase 2 is: teach the existing review-scoped subsystem that a local review can carry a PR target, and unhide the frontend in local mode. Smaller than planned — but it surfaces one real design decision the sketch never raised.

#### Design decision: anchor trust (settle before coding)

External comments carry `(file, line, side)` resolved against the **PR head commit**. `_resolveAnchor` (`external-comment-manager.js:378`) hands that to `_findDiffLineRow` (`:327`), which matches by line number against whatever diff is currently rendered.

- PR mode: the rendered diff **is** the PR head commit. The numbers agree by construction.
- Local mode: the rendered diff is the working tree vs base, and `--scope` can make it a different diff entirely. A line number from PR head can resolve to a *different* line locally, silently.

The existing file-level fallback (`_renderFileFallback` `:691`, `_renderPierreFileFallback` `:662`) catches "line not found". It does **not** catch "line found, wrong content". That is the failure mode to design against.

**Decision: trust precise anchors only when local `HEAD` equals the PR's `head_sha`.** Otherwise route every thread through the file-level fallback with a "from PR #N — your working tree has moved since" note. Cheap, honest, and it reuses machinery that already exists. `head_sha` is already stored by Phase 1's `normalizePRMetadata`, so the comparison needs no extra fetch.

Rejected: (a) always render precise anchors — silently wrong line, the worst outcome; (b) re-anchor by content search — real work, defer until someone asks.

#### Backend

`src/routes/external-comments.js` is the only backend file that must change.

1. **`isPRMode(review)` (`:101`) is the single choke point.** Both sync and fetch route through it on purpose ("sync and fetch stay in lockstep"). Do **not** add a second predicate. Replace it with a target resolver:
   ```
   resolveCommentTarget(review) -> { owner, repo, prNumber, repository } | null
   ```
   - PR-mode row (today's `isPRMode` truth table) → `review.repository` / `review.pr_number`.
   - Local row (`review_type='local'`, `local_path` set) carrying `associated_pr_number` + `associated_pr_repository` → those.
   - Anything else → `null`.

   Preserve the asymmetric null contract that already exists: sync 400s on null, fetch returns `{ threads: [] }` (`:397`) so the frontend can call it unconditionally.

2. **`executeSync` (`:123`) reads the target from the review row in three places** — all three go through the resolver:
   - `:132` `String(review.repository).split('/')`
   - `:147` `getPRHost(review.repository, review.pr_number)`
   - `:166` `pull_number: review.pr_number`

3. **Credentials already work unchanged.** `adapter.resolveCredentials(config, repository, _deps, { storedHost })` is repository-driven, so an associated PR on an alt host resolves its own binding. But the capability flag must agree with it — compute `canViewPRComments` via `resolveFetchCredential` (`pr-context.js`), exactly as Phase 1 did for `hasGitHubToken`, or the flag promises a fetch that 401s.

4. **Flip `canViewPRComments`** in `buildCapabilities` (`pr-context.js:149`):
   ```js
   canViewPRComments: Boolean(hasAssociatedPR && hasToken)
   ```
   This is the first action flag NOT gated on cached metadata — comments and metadata are independent fetches, so do not gate on `prMetadataAvailable`. (The anchor-trust check does want `head_sha`; when metadata is cold, degrade to file-level rendering rather than withholding the comments.)

5. **No new endpoint.** The sketch's `GET /api/local/:reviewId/pr-comments` is **dropped**. `/api/reviews/:reviewId/external-comments` already accepts a local review id — local rows live in the same `reviews` table.

6. `inFlight` (`:60`) and `writeChain` (`:75`) need no change: keyed on `review.id`, already mode-agnostic.

#### Frontend

Two hard local-mode bails to remove. Both are mode-sniffs that design principle 3 already forbids.

1. `public/js/pr.js:1204` — `_loadExternalComments()` opens with `if (window.PAIR_REVIEW_LOCAL_MODE) return;`. Replace with `if (!this.hasCapability('canViewPRComments')) return;`. PR mode defaults that flag `true`, so PR behaviour is unchanged.
2. `public/js/components/AIPanel.js:67-69` — hides the External segment when `localMode || externalDisabled`. Replace the `localMode` half with the capability check. Keep `externalDisabled` — that is the global kill switch.

Then:

3. `public/local.html` — add `<script src="/js/modules/external-comment-manager.js"></script>` (model: `pr.html:461`). The External segment button already exists at `local.html:597` (`hidden`), and `/runtime-config.js` already loads at `:740`, so the kill switch works in local mode today.
4. `public/local.html` — add the refresh button (`#refresh-external-comments-btn-panel`, model `pr.html:345`). `pr.js:595` already guards on `_externalCommentsEnabled()`; add the capability check alongside it.
5. `public/js/local.js` — invoke the sync+render path after the diff renders. Capability flags can arrive late (`_maybeWarmPRMetadata` at `:1596` is the precedent): re-render when `canViewPRComments` flips, do **not** latch.
6. **Read-only audit.** Check `_buildCommentElement` (`:876`) and the chat affordances (`:976`, `:1000`, `:1032`) for any reply/resolve control. Anything that writes back to GitHub must be suppressed in local mode — there is no local write path until Phase 5.

#### Tests

Extend the existing files; do not create parallel ones.

- `tests/unit/external-comments-sync.test.js`, `tests/unit/external-comments-fetch.test.js` — local-review-with-association cases on the target resolver; existing PR-mode truth table stays green.
- `tests/unit/pr-context.test.js` — `canViewPRComments` truth table (association × token × alt-host-without-token).
- `tests/unit/external-comment-manager.test.js` — anchor trust: `HEAD === head_sha` renders precise; `HEAD !== head_sha` routes to file-level.
- `tests/unit/ai-panel-external-segment.test.js` — segment visible in local mode when the capability is true, hidden when false. **This file asserts the opposite today**; updating it is the signal the mode-sniff is genuinely gone.
- `tests/unit/pr-external-comments-wiring.test.js` — the `_loadExternalComments` gate swap.
- `tests/integration/external-comments-sync.test.js` + `-fetch.test.js` — real SQL: local review with association syncs; without association 400s (sync) / `{threads:[]}` (fetch); PR-mode rows unchanged.
- E2E: local review with an associated PR shows external comments inline.
- **Regression (parity rule):** the full pure-PR-mode external-comments suite green and untouched.

#### Hazards specific to this phase

- `isPRMode` is shared by both routes deliberately. Two predicates means sync and fetch disagree about what has comments — mirror rows that get written and never read.
- `tests/unit/ai-panel-external-segment.test.js` encodes "hidden in local mode" as correct today. Flipping it is intended, but confirm each assertion you change is the mode-sniff, not an unrelated kill-switch case.
- `deleteMissing` (`:226`) prunes rows unseen this sync, scoped `(review_id, source)`. Local and PR reviews are distinct rows, so there should be no cross-mode pruning — prove that with a test rather than by reading.
- **Migration numbers are provisional until the rebase:** this branch's 56 and 57 were chosen against a `main` at 55, and other in-flight work has claimed 56 too. Do not treat either number as owned. **Renumber against main's actual `CURRENT_SCHEMA_VERSION` at rebase time** — see the rebase note at the top of this plan for why the window closes at merge and what it costs to miss it.

Changeset: `minor` — "Show existing PR review comments inline in local reviews."

### Phase 3: Stale detection vs PR head — SHIPPED

**Goal:** Local stale check also compares against PR `head_sha`.

#### Reality check (recon 2026-08-20 — supersedes the original sketch)

The sketch proposed one provider, `checkStale({ reviewId, includePRHead }, _deps) -> { isStale, reasons }`, extracted from both routes. That shape does not survive contact:

- The two handlers share almost nothing. Local compares a working-tree digest against the stored diff digest; PR compares the `pr_metadata` cache against a live GitHub fetch. Only the *remote PR-head read* is common.
- A provider that OWNED `isStale` would be the single easiest place to accidentally fold PR drift into it — the one thing this phase must not do (see decision 9).

So only the genuinely shared parts were extracted. The mode-specific halves stayed in their routes.

#### What shipped

- `src/providers/stale-check.js` (NEW) — `STALE_REASONS`, `PR_HEAD_CHECK_TIMEOUT_MS` (1200), `PR_HEAD_TIMEOUT_ERROR`, `buildStaleReasons`, `describeGitHubError`, `withoutTokenRefresh`, `fetchRemotePRHead`, `checkPRHeadState`. `defaults + _deps` DI. Imports `GitHubClient` and `logger` and nothing else.
- **`isStale` stays working-tree-only.** PR data ships in a separate `prHead` block plus `reasons[]`. See decision 9 — this is the load-bearing decision of the phase.
- `GET /api/local/:reviewId/check-stale` keeps every pre-existing field and adds `reasons` (always an array of `{code, message}`) and `prHead` — `null` when no fetch was attempted (no association / no usable credential / `hostAmbiguous`), else `{checked, prNumber, repository, localHeadSha, remoteHeadSha, cachedHeadSha, drifted, prAdvanced, prState, merged, error}`. `drifted` = current local HEAD vs remote head, TRI-STATE (`null` when either SHA is unknown — round 3); `prAdvanced` = remote head vs the `pr_metadata` cache.
- `GET /api/pr/...check-stale` refactored onto `fetchRemotePRHead` + `describeGitHubError`, gaining `reasons`. Every pre-existing field keeps its name, type and value on every path (parity rule).
- `buildCapabilities` → `canCheckStaleVsPR: Boolean(hasAssociatedPR && hasToken)`. Deliberately NOT gated on `prMetadataAvailable`, same reasoning as `canViewPRComments`: the check is a live fetch and needs no warm cache.
- `public/js/pr.js` `_showStaleBadge` gained a `pr-drift` variant (`PR DRIFT`, blue — informational, since refreshing cannot fix it). Local mode also now surfaces `MERGED` / `CLOSED` for an associated PR. **Round 2 replaced the single badge element with a badge GROUP** — three independent slots (`#stale-badge`, `#pr-state-badge`, `#pr-drift-badge`), so there is no priority to get wrong; see the round-2 notes below.
- `prAdvanced` drives Phase 2's metadata refresh — a convergence the sketch missed. `pr_metadata` has no TTL and its `head_sha` is one operand of Phase 2's anchor-trust gate; `prAdvanced` is precisely "that cache is behind", so the stale check became the freshness signal Phase 2 lacked, and anchor trust self-heals.

**Delta — the seven-exit refactor.** The local handler hand-assembled its payload at seven `res.json` sites. Every one would have had to remember two new fields. They now funnel through a single `respond()` that merges `prHead` + `reasons`, with a `responded` guard, since `respond` awaits and a throw inside it would otherwise land in the handler's catch and double-send.

**Delta — `fetchPRMetadata` is the trap, not the reuse.** It looks like the natural thing to call: it already fetches a PR and handles host bindings. It is cache-first and WRITES THROUGH. PR mode's check compares against that cache, so a write-through would make every subsequent check report "not stale" forever. The provider is read-only and imports no repository; a unit spy and a double-call integration test both pin it.

**Delta — the 2000ms client abort became load-bearing.** `_fetchLocalStaleness` aborts at `STALE_TIMEOUT = 2000ms` and the endpoint had only ever done local git work. An unbounded GitHub round-trip would let a slow GitHub take the *working-directory* answer down with it — a regression in local mode's core feature in service of an advisory extra. The fetch is kicked off before the git work (so it overlaps), `.catch()`-attached in the same expression (so an early return cannot leak a rejection), and bounded at 1200ms server-side.

#### Review round (2026-08-20) — fixes applied

An integration review of the seam between the two parallel implementers found six issues. All fixed.

- **A redundant capability gate that could go stale (most severe).** The metadata refresh was gated on `hasCapability('canCheckStaleVsPR')` while the badge beside it was correctly ungated — the asymmetry the plan's own async-race hazard predicts. `this.capabilities` is a page-load snapshot; on a dirty-tree load the association is not yet backfilled, so a late-arriving association rendered the badge but skipped the metadata re-read, leaving Phase 2's anchor-trust gate comparing against a stale cached head with nothing else to re-fire it. `prAdvanced === true` IS the backend saying it fetched and the cache is behind; a page-load snapshot must not veto a fresher answer. Gate removed. **This one originated in the written contract, not the implementation.**
- **A false fact fed to the AI.** The not-stale branch is `isStale !== true`, which includes `null` ("could not determine") — and the backend returns `isStale: null` *with* a populated `prHead` on the no-stored-diff and catch-all paths. The chat notification asserted "The working tree is current", a claim the backend had explicitly declined to make, into the agent's context via `queueDiffStateNotification`. The claim is now conditional on `isStale === false`.
- **Refresh cleared a badge it cannot fix.** `_applyRefreshedDiff` hides the badge and nothing re-evaluated PR state, so clicking Refresh — the only visible affordance — hid drift for the session while it was still true. `_recheckPRHeadState()` re-asks the backend and re-applies ONLY the PR-side badge. It must never route through `_checkLocalStalenessOnLoad`, which can call `refreshDiff({silent:true})` and re-enter `_applyRefreshedDiff` — an unbounded loop; the guard is commented and tested.
- **`reasons[]` could contradict its own payload.** The catch block reset `currentHeadSha` but not the reason flags, so a response could report `headShaChanged: false` beside a `local-head-moved` reason. `clearLocalReasonFlags()` in the catch. All ten `respond()` sites audited; only the catch disagreed.
- **Duplicate forced fetch on the silent auto-refresh path.** Fixed via an explicit `forcedPRMetadataRead` return value rather than a blanket skip — **the review's stated premise was wrong**: `_applyRefreshedDiff` forces the read only when `headMoved || userInitiated`, so an unconditional skip would have LOST the forced read on a silent refresh where local HEAD had not moved, which is exactly the push-with-no-local-commit case `prAdvanced` exists for.
- **A cross-file invariant pinned on one side.** The provider's deadline must stay under `STALE_TIMEOUT` in `public/js/pr.js`, but the test asserted against a hardcoded `2000`. Lowering `STALE_TIMEOUT` would have left every test green while the feature broke. The test now parses the real value out of `public/js/pr.js` and names both files on failure.

**Accepted residual — CLOSED in round 2**

Credential resolution ran *before* the deadline and was synchronous: on a `github_token_command` that fails, `config.js` caches nothing, so `execSync` blocked the event loop for up to 5s, which a `Promise.race` cannot preempt. Round 2 fixed it properly rather than accepting it — `resolveHostBinding` takes a `cachedTokensOnly` option that answers from config.js's process-lifetime token cache or not at all, and `startPRHeadCheck` passes it. A command nobody has run yet simply yields no credential and the PR-head add-on is skipped; the working-tree answer is never at risk. Token-less answers from a cache-only resolution are deliberately NOT written to `pr-context.js`'s 30s negative memo (a command that never ran is no evidence), and the refresh closure strips the flag (its whole job is to re-run the command).

**Test deltas**

- `tests/unit/stale-check.test.js` (NEW). `tests/unit/local-stale-badge.test.js`, `tests/unit/pr-context.test.js`, `tests/integration/routes.test.js` extended. Integration coverage builds a real temp git repo (per-file `mkdtemp`, `GIT_CONFIG_GLOBAL=/dev/null`) — the block's fake `/tmp/test-repo` forces `isStale: true` via the digest fail-safe and so cannot demonstrate that the two halves move independently.
- Reason fixtures are built from the real `STALE_REASONS` table, not hand-copied strings, so a message change cannot pass vacuously.
- `tests/unit/local-pr-pill.test.js` needed a fixture fix: its `mockFetch` parked *any* non-`refresh=1` URL on a captured resolver, which the new post-refresh `check-stale` request then claimed, hanging the test. No production behaviour was bent to fit it.

#### Review round 2 (2026-08-21) — feedback applied

The badge design and several ordering hazards. All fixed.

- **One badge element for three independent facts (design).** Lifecycle, working-tree freshness and commit alignment can all be true at once, and a single `#stale-badge` forced whichever was evaluated last to erase the others — which also made the two modes disagree about priority. Replaced by a badge GROUP: `#stale-badge` (STALE), `#pr-state-badge` (MERGED|CLOSED), `#pr-drift-badge` (PR DRIFT), rendered by the shared `_showStaleBadge`/`_hideStaleBadge` on `PRManager`. `_hideStaleBadge(slot)` is what lets a refresh clear only the state it actually fixed. **This dissolved rather than fixed the badge-priority inversion** the round also found (the post-refresh recheck painting the informational PR DRIFT over the actionable STALE): with independent slots there is no precedence to invert.
- **The post-refresh recheck destroyed the refresh's own chat snapshot.** `queueDiffStateNotification` stores ONE snapshot per tab, so each call replaces the last — and `_applyRefreshedDiff` was calling it twice (losing its own HEAD-change sentence) before firing a recheck whose message overwrote both a round-trip later. Now: one composed message, handed to `_recheckPRHeadState` as a `preface` it restates.
- **`workingTreeNote` reported `isStale: true` as "could not be determined".** It was a two-way ternary on `=== false`. Now three-way, plus an override for the post-refresh path, whose `isStale: null` means "not asked", not "unknown".
- **Nothing versioned the staleness or metadata requests.** Two unawaited paths write the PR-side badges and two can write `associatedPR.head_sha`; whichever RESPONSE landed last won, regardless of which REQUEST was newer. Both now carry a monotonic generation stamp, and the not-drifted / open-PR paths explicitly CLEAR their slots so the newest answer can retract an older one.
- **A late association left the badges dead for the session.** On a dirty tree the `associated_pr_*` columns are empty when the on-load check reads them, and `_applyRefreshedDiff` was the only other trigger. `_refreshPRMetadata` now fires the guarded recheck on the `!hadAssociation -> hasAssociatedPR` transition it already computes.
- **Every refresh spawned a second full working-tree digest.** `?prHeadOnly=1` answers about the PR head alone (still reading local HEAD, without which `drifted` is meaningless) and skips the stored-diff read and `computeScopedDigest` entirely.
- **`describeGitHubError` keyed off `.code`, which `GitHubClient` never sets.** `handleApiError` normalises everything to `GitHubApiError` with `status` only, so offline and rate-limited both fell through to the raw internal message — including a "Retrying in 3600 seconds…" line that lies on a fail-open path. Now keyed on `status` (with `.code` kept as a secondary guard) and guaranteed to return a string, which also stops `JSON.stringify` dropping PR mode's `error` key.
- **The 1200ms deadline bounded the wait but never cancelled the request.** An `AbortSignal` now threads from `checkPRHeadState` through `fetchRemotePRHead` into `GitHubClient.fetchPullRequest` (Octokit `request: { signal }`), aborted in the same `finally` as `clearTimeout`.
- **The `[perf]` probes stopped the clock before the new cost.** They measured the local half and returned *then* awaited the remote half for up to 1200ms. Moved inside `respond`, logging `local=Xms total=Yms`.
- **PR mode built `reasons[]` that no PR-mode consumer could render** — the renderer was a `static` on `LocalManager`, in a file PR-mode pages never load. Moved to `PRManager.formatStaleReasons`; `LocalManager` delegates; PR mode passes it as the badge title. The E2E fakes now ship `reasons` too.
- **Test gaps closed:** the `hostAmbiguous` refusal on check-stale (with a control proving the fixture reaches the fetch), the malformed-association and cached-read-failure guards, `prHeadOnly` behaviour, and a marker-file test proving no `token_command` is executed on this path. Three hand-typed reason fixtures (one already wrong) now come from the real `STALE_REASONS`, and the per-call `timeoutMs` test — which could not fail, because a microtask always beats a 0ms timer — was rebuilt on fake timers. Both new guard tests were mutation-checked.

#### Review round 3 (2026-08-22) — feedback applied

Eight findings, all fixed. Six of the eight are the same shape as round 2's lesson, one level down: **a mechanism built for one domain was applied to another, and the mismatch only shows when two paths overlap.**

- **A PR-only recheck cancelled the working-tree answer (critical).** Round 2's single generation counter was stamped by `_recheckPRHeadState` too — but `?prHeadOnly=1` explicitly answers `isStale: null` ("not asked") and cannot recapture the tree, so it has no standing to supersede anything on that side. The late-association recheck fires on the ordinary dirty-tree load, so a pending on-load `isStale: true` was routinely discarded before it could show STALE, notify chat, or silently refresh an empty session — and nothing later restores those effects. Now ONE COUNTER PER DOMAIN: `_prHeadCheckGeneration` (stamped by the on-load check and every recheck) and `_workingTreeCheckGeneration` (stamped by the on-load check and by `refreshDiff` — before the POST, so a parked check cannot start a second concurrent refresh — and again in `_applyRefreshedDiff` when the recapture lands).
- **A late association dropped `prAdvanced`.** A warm-up that resolves an association from an existing `pr_metadata` row can resolve it from an OLD one; the recheck it fires correctly reported `prAdvanced: true` and then only wrote badges, while the on-load check — which saw no association — could not have asked. `_recheckPRHeadState` now also drives `_refreshPRMetadataIfPRAdvanced`. Bounded: the forced read cannot re-announce a gained association, because the apply block that fired the recheck already made `hasAssociatedPR` true.
- **A late association overwrote a KNOWN working-tree state with "could not be determined".** Same root cause as the first item, in the notification instead of the badge: `queueDiffStateNotification` replaces the single stored snapshot, and the gained-association recheck passes no `workingTreeNote`, so its unasked `isStale: null` was rendered as "unknown" over a fact the full check (or a refresh) had established. The latest working-tree statement is now remembered separately (`_workingTreeNote`) and composed in at apply time; with nothing remembered yet the clause is OMITTED rather than invented. `LocalManager.workingTreeNoteFor` derives the three real answers; the four note strings are module constants.
- **`cachedTokensOnly` still permitted a blocking token-command run (critical).** It governs whether a command runs to PRODUCE a binding — but a binding already in the cache carries its `refresh` closure, which `GitHubClient` invokes after a 401 and which deliberately does not inherit the flag. An expired cached token therefore still reached `execSync` (5s, synchronous, unpreemptable) on the advisory path the client abandons at 2000ms. `fetchRemotePRHead` now strips the closure (`withoutTokenRefresh`) — for BOTH check-stale routes, since both are advisory and fail-open — so a 401 falls through `describeGitHubError` instead of shelling out. Regression test warms the cache, 401s the fetch, and proves the command did not re-run *and* that the closure it stripped was real.
- **An unknown local HEAD was reported as `drifted: false`.** `Boolean(a && b && a !== b)` collapses "not answered" into a confident negative, and the frontend reads an explicit false as "the heads agree now" and RETRACTS the badge — so a half-answered check erased what a complete one had established. `drifted` is now tri-state, and `_applyPRHeadStaleState` clears the drift slot only on an explicit `false`. Same rule `prHead.error` already followed: an unknown must not clear a known.
- **Refresh left the PR lifecycle badge stale (PR mode).** `refreshPR` cleared only the freshness slot, though the payload it just fetched is authoritative about lifecycle — so a reopened PR kept showing CLOSED and one merged mid-session showed nothing until a reload. New shared `PRManager._applyPRLifecycleBadge`, used by both `_checkStalenessOnLoad` and `refreshPR`; it clears the slot for an open PR so a reopen retracts. Needed a backend half: neither PR payload shipped `merged`, so `state` alone could not distinguish MERGED from CLOSED. Both the GET and refresh responses now carry it.
- **Legacy viewed-state migration read through without writing through.** The fallback adopted the legacy commit-scoped marks into memory and waited for the next save — but the legacy key is derived from the CURRENT head, so a HEAD move before the user happened to toggle a file made the next load derive a different key, miss, and hard-reset the set. `_applyRefreshedDiff` moves `head_sha` and reloads with zero interaction, so that window is the normal case. The adoption now persists immediately; the legacy key is left in place (adoption, not migration).
- **A test depended on the developer's environment.** The no-credential case cleared app/config credentials but left `process.env.GITHUB_TOKEN`, which `resolveHostBinding` consults first — so an exported token made the fetch run and the test fail. Saved/deleted/restored in a `finally`, matching the neighbouring cases.

**Test deltas:** `tests/unit/pr-lifecycle-badge.test.js` (NEW — PR-mode lifecycle reconcile through both `_checkStalenessOnLoad` and `refreshPR`). `tests/unit/local-stale-badge.test.js` +14 (domain-split interleavings including the REAL `_refreshPRMetadata` late-association trigger, the convergence from a warm-but-stale row, both note-composition orders, tri-state drift). `tests/unit/local-refresh-animation.test.js` +1 (adopted marks survive a HEAD change with no toggle). `tests/unit/stale-check.test.js` +3. `tests/integration/routes.test.js` +1 (warm-cache 401). Every new production behaviour was mutation-checked by reverting the fix and confirming the specific test fails.

Changeset: `.changeset/local-stale-check-pr-head-drift.md` (`minor` — this phase ships user-facing badges, a new public contract field, and flips `canCheckStaleVsPR`; the original `patch` predates that scope, and both sibling phases shipped `minor`).

### Phase 4: Pending draft sync — SHIPPED

**Goal:** Pull drafts started in GitHub UI into the local session.

**What shipped:**
- `src/providers/draft-sync.js` (NEW). Three exports:
  - `syncPendingDraftFromGitHub(...)` — verbatim extraction from
    `src/routes/pr.js`, same signature, still re-exported through that file's
    `_internals` because its regression suite addresses it there.
  - `syncPendingDraft({ db, reviewId, owner, repo, prNumber, credential }, _deps)`
    — the whole flow (fetch → reconcile → report every mirror row), so the two
    endpoints that need `pendingDraft` AND `allGithubReviews` cannot diverge.
    **Asymmetric error contract, documented on the function:** building the
    client THROWS (an unusable credential is a caller bug — every caller
    resolves one through `resolveFetchCredential` first), the GitHub round-trip
    does NOT (draft state is supplementary; the failure is logged and the local
    mirror is returned unchanged, exactly as both PR-mode call sites behaved
    before the extraction).
  - `serializePendingDraft(row)` — one definition of the wire shape, so PR
    mode's `github-drafts` body and local mode's `sync-drafts` body are
    byte-identical. `PRManager.updatePendingDraftIndicator` reads both.
- `src/routes/pr.js`: `GET /api/pr/:owner/:repo/:number` keeps calling
  `syncPendingDraftFromGitHub` directly (it already holds a client and never
  reports the full list); `GET .../github-drafts` now goes through
  `syncPendingDraft` + `serializePendingDraft`. Response shape unchanged.
- `src/routes/local.js`: `POST /api/local/:reviewId/sync-drafts`. POST because
  it writes (mirror reconciliation can transition an old pending row to
  submitted/dismissed) and always reaches GitHub. Deliberately NOT called from
  `GET /api/local/:reviewId` — that is the page-load path and must never block
  on a round-trip; the client asks for itself. Status ladder: 400 malformed id,
  404 no review, 403 no *usable* association (`isUsablePRTarget`, the same
  predicate `buildCapabilities` uses, so gate and capability cannot disagree),
  409 unresolvable dual-host, 401 no credential, 200 otherwise.
- `buildCapabilities`: `canSyncDrafts: hasAssociatedPR && hasToken && hostResolved`.
  Deliberately NOT gated on `prMetadataAvailable` — same reasoning as
  `canViewPRComments` / `canCheckStaleVsPR`: the sync asks GitHub directly, so
  a cold cache is not an input, and gating on it would hide the control on
  exactly the first load where a GitHub-UI draft is most likely to be waiting.
  It IS gated on the host (review round; see below).
- `public/local.html`: `#local-sync-drafts-btn` in `#toolbar-meta`, right after
  `#pr-commit` (where `updatePendingDraftIndicator` inserts). Hidden with an
  inline `display`, NOT `hidden` — `.btn` sets an author-origin `display` that
  beats the UA `[hidden]` rule (same collision the PR pill's container
  documents).
- `public/js/local.js`: `_updateDraftSyncAffordance` (re-reads the capability
  every call, never latches, retracts when it goes false), `_syncGitHubDrafts`
  (in-flight JOIN, not a latch — button and auto-sync can fire milliseconds
  apart and two concurrent POSTs race the reconciliation), and
  `_maybeAutoSyncGitHubDrafts` (one automatic sync per page load, spent by
  whichever of `loadLocalReview`'s tail or `_refreshPRMetadata`'s late flip
  gets there first). Manual syncs toast and additionally re-sync external
  comments; automatic ones are silent.
- `public/js/pr.js`: `updatePendingDraftIndicator(pendingDraft)`.
  **Two-sided contract:** PR mode prefers the `url_template`-built URL because
  some alt-hosts return a wrong-host `github_url`, and that is safe only
  because the RepoLinks substitution context carries `{number}`. Local mode
  shipped with a `preferConfiguredUrl: false` opt-out because its context
  omitted the number; the review round removed the opt-out by giving local mode
  the association's number instead (see below).

**Tests added:**
- `tests/unit/draft-sync.test.js` (NEW) — provider: mirror creation, no-draft,
  swallowed GitHub failure, propagated construction failure, credential
  pass-through, `serializePendingDraft` wire shape.
- `tests/integration/local-sync-drafts.test.js` (NEW) — the full status ladder
  plus idempotency (a second sync updates the one row rather than creating a
  second) and the association-targeted call (`owner`, `repo`, 77 — never the
  local row's null natural key).
- `tests/unit/local-draft-sync.test.js` (NEW, jsdom) — affordance show/hide/
  retract, listener-attached-once, in-flight join, release-after-failure,
  manual-vs-auto toasting and external re-sync, auto-sync budget, and draft-URL
  resolution.
- `tests/e2e/local-draft-sync.spec.js` (NEW) — computed-style visibility of the
  button (an attribute assertion passes against the `hidden` bug), the
  indicator rendering into local.html's toolbar at all, the button picking up a
  draft started after page load, and a server refusal leaving the page usable.
- `tests/unit/pr-context.test.js`, `tests/integration/routes.test.js` — the
  Phase-4 flag moved out of the "unshipped, pinned false" set into its own
  truth table.

Changeset: `.changeset/local-mode-github-draft-sync.md` (`minor`).

#### Review round (same branch, before merge)

Ten findings, all addressed. What changed materially:

- **A transient lookup no longer rewrites history.** `getReviewById` throwing
  established nothing, yet the old-record loop wrote `dismissed` — so a rate
  limit could durably record a SUBMITTED review as thrown away. The loop moved
  into `reconcileOldPendingRecords`; an indeterminate lookup now leaves the row
  at its last known state and a later sync reconciles it. `dismissed` is
  reserved for an authoritative answer (state DISMISSED, or a not-found for an
  id GitHub would know) plus the one row we cannot look up at all.
- **Scenario 3 is implemented, not just documented.** The docblock claimed the
  caller handled "no draft on GitHub but pending rows here"; neither caller
  did, so those rows stayed `state='pending'` forever and kept shipping in
  `allGithubReviews` next to `pendingDraft: null`. `syncPendingDraft` now runs
  the same reconciliation for that case — on the SUCCESS path ONLY, because
  doing it on the swallowed-error path is how a rate limit mass-dismisses live
  drafts.
- **"No draft" and "could not ask" are now distinguishable.** The response
  carries `syncSucceeded`. Local mode leaves the indicator, `currentPR.pendingDraft`
  and its return value untouched on a failure (manual syncs warn instead of
  reporting "No draft review on GitHub"). The GitHub catch narrowed to the
  fetch: reconciliation and the mirror read run outside it, so a DATABASE
  failure reaches the route's 500 instead of being reported as an outage.
- **One mirror row per GitHub review, enforced.** Migration 57 adds partial
  unique indexes on `(review_id, github_node_id)` and
  `(review_id, github_review_id)`, collapsing existing duplicates first.
  `GitHubReviewRepository.upsertFromGitHub` is now the ONE writer for a row
  with a GitHub identity — used by the draft sync AND by both submit paths
  (`routes/pr.js`, `main.js`), because submitting a draft keeps the same review
  id and node id and must update that row rather than insert a second one.
  The provider also single-flights per (db, reviewId).
- **`canSyncDrafts` no longer advertises a button that always 409s.**
  `resolveAssociationHost` (routes/local.js) answers "is the PR's host known?"
  in two tiers — the resolved binding, then the stored `pr_metadata.host`
  stamp — and BOTH the capability and the endpoint gate read it, so they cannot
  disagree. A stamped host also settles the sync itself: `resolveRepositoryBinding`
  accepts a `host` option that replaces the dual-host guess, so a dual repo
  already opened in PR mode syncs instead of refusing.
- **The draft link is host-correct in both modes.** `RepoLinks.draftUrl` is the
  one resolver (indicator + ReviewModal notice). `LocalManager._applyRepoLinks`
  resolves the link set against the ASSOCIATED PR (owner/repo/number, and the
  association's repository wins over the checkout's), re-applied on a late
  association and awaited before the indicator renders — which is what let the
  `preferConfiguredUrl: false` opt-out go away.
- **A retracted capability clears the indicator too.** `_updateDraftSyncAffordance`
  hid the button but left a live "Draft on GitHub" link to a draft on a PR the
  session was no longer tied to, with no affordance left that could refresh it.
- **`GET /api/pr/:owner/:repo/:number` uses `serializePendingDraft`.** It was
  still hand-rolling the same six fields — and it is the endpoint the UI
  actually reads `pendingDraft` from, so "one definition" was not true.
- Tests: late-flip auto-sync and its retraction mirror asserted through
  `_refreshPRMetadata` (not by calling `_maybeAutoSyncGitHubDrafts` directly);
  state-mapping and indeterminate-lookup cases; scenario 3; concurrent syncs;
  `upsertFromGitHub` against a real database; migration 57 dedupe; the E2E
  manual-resync test waits for the automatic request to land instead of racing
  it through the single-flight join.

#### Review round 2 (2026-08-22) — feedback applied

Four findings, all addressed.

- **The transports made round 1's "indeterminate lookups do not mutate" rule
  unreachable (critical).** `reconcileOldPendingRecords` treats `null` from
  `getReviewById` as authoritative and writes `dismissed` — but BOTH production
  transports answered `null` for every failure, so the protective catch never
  saw the rate limits and 5xx it exists for. The REST impl also answered `null`
  when it could not even BUILD a lookup (a node id with no numeric id), i.e.
  for a query never made. Fixed at the contract, not the caller:
  `src/github/impl/graphql/pending-review.js` returns `null` only for a
  NOT_FOUND error or a missing node (and raises when the node is not a review
  at all), `src/github/impl/rest/pending-review.js` only for a 404 — everything
  else rejects. Only then does the provider's catch mean anything. The unit
  tests modelled failures as rejections, which is exactly why they missed it;
  the transports now carry their own 404-vs-rate-limit-vs-5xx cases.
- **A legacy split identity broke `upsertFromGitHub` (medium).** Migration 57
  deduplicated node ids and numeric ids INDEPENDENTLY, so a pair can survive it
  as two rows — one holding the node id, one the numeric id, for the same
  GitHub review. The old code took the first lookup that hit and then wrote the
  other identifier into it, violating the sibling's unique index; only the
  INSERT path handled uniqueness, so sync surfaced a raw constraint failure.
  Now both identifiers are resolved, a split pair is merged (higher id wins,
  matching migration 57's `MAX(id)`; the loser's non-NULL columns are folded in
  first) inside a SAVEPOINT — not a transaction, because `src/main.js`'s submit
  path already holds one — and the unique-conflict retry covers the UPDATE as
  well as the INSERT. Absent identifiers are normalised to SQL NULL at the
  repository boundary: `String(databaseId)` on a missing id stored the literal
  `"null"`, a shared identity two unrelated reviews then matched each other on.
  The draft sync omits the column entirely when GitHub sends no `databaseId`,
  so a response without one cannot blank an id already recorded.
- **The capability and the endpoint used different credentials (medium).** Both
  capability endpoints resolved the binding with the ambiguity rule, THEN asked
  `resolveAssociationHost` which host the PR is on, and shipped the flag
  computed from the pre-stamp guess — while `POST /sync-drafts` re-resolved
  against the stamp. On a dual repo that got both asymmetric configurations
  backwards: a global github.com token advertised a button whose requests 401,
  and an alt-host repo token hid a working feature. One helper now settles the
  host FIRST and re-resolves the binding for it —
  `resolveAssociationCredential` (routes/local.js) — and all three sites use
  it, including `/pr-metadata`'s fetch.
- **Explicit-host re-resolution failed open (critical).** `tryResolveHostBinding`
  swallows the deliberate stale-host/config mismatch throw and answers `null`,
  which `resolveFetchCredential(null, token)` reads as an ordinary github.com
  binding — so a stored host that config no longer describes sent the sync to
  api.github.com for a PR the route had just proved lives elsewhere, and a
  same-named github.com repo's PR #N would be reconciled into these rows. The
  new helper distinguishes "no binding needed" from "explicit resolution
  FAILED" (`hostBindingFailed`) and every consumer fails closed: 409 from
  sync-drafts, no fetch and no credential from either capability endpoint.

### Phase 5: Submit review to GitHub — IMPLEMENTED (uncommitted)

**Goal:** Submit a local-mode review as a real GitHub review. The only phase
that writes to GitHub.

**What shipped**

- `src/providers/review-submit.js` (NEW) with four exports:
  - `submitReview({db, reviewId, owner, repo, prNumber, event, body, credential,
    prNodeId, headSha, diffContent, filesWithLocalEdits, hostName}, _deps)` —
    the whole write, extracted verbatim from `routes/pr.js`. Loads the active
    user comments, shapes them, reuses or creates the GitHub review, then
    records the outcome in one transaction opened AFTER the network call.
    THREE callers by the end of the round — both web routes and the headless
    flow in `src/main.js` — so the extraction is the one write path, not a
    two-route convenience. See the 2026-08-23 review round for the headless
    fold and its `commentsOverride` seam.
  - `checkSubmitPreconditions({owner, repo, prNumber, credential, localHeadSha})`
    — LOCAL MODE ONLY. A live PR read: merged/closed → 410, HEAD drift → 409,
    unreadable GitHub → 502, missing PR → 404. **Fails CLOSED**, the opposite
    of every other PR-side check in local mode, because those inform and this
    one authorises a write. Uses the FULL credential (not
    `withoutTokenRefresh`): a user-initiated write has no deadline, so an
    expired cached token should refresh rather than become a refusal.
  - `SubmitReviewError` — the one refusal the provider decides (missing GraphQL
    PR node id) carries `status` + `code`; everything else propagates unchanged
    so each route's existing message-substring ladder still classifies it.
  - `SUBMIT_EVENTS` — one list, every caller.
- `POST /api/local/:reviewId/submit-review`. Ladder: 400 id / 400 event / 404
  review / 403 association / 409 host (ambiguous or `hostBindingFailed`) / 401
  credential / precondition status / 200. Every refusal body carries a `code`
  beside `error` so the client can tell a drift refusal from a lifecycle one.
  Host and credential go through `resolveAssociationCredential` — the same
  resolver, in the same order, as the two capability endpoints and sync-drafts.
- `buildCapabilities`: `canSubmitToGitHub = hasAssociatedPR && hasToken &&
  hostResolved` — identical to `canSyncDrafts`, host requirement included, and
  deliberately NOT gated on `prMetadataAvailable` (the endpoint reads the PR
  live; it must, to refuse a drifted one).
- Frontend: `PRManager.getSubmitReviewEndpoint()`, patched in
  `LocalManager.patchPRManager` to `/api/local/:reviewId/submit-review`.
  `ReviewModal` asks the manager for it instead of building a PR-shaped URL.
  `PreviewModal` migrated off the `window.PAIR_REVIEW_LOCAL_MODE` sniff onto
  `hasCapability('canSubmitToGitHub')`.
- `localReview.listFilesModifiedVsHead(repoPath)` (NEW) — `git diff --name-only
  -z HEAD`. THROWS rather than answering an empty set, because an empty set is
  indistinguishable from "the tree is clean", which is the claim that buys a
  comment its line number.

**Delta — a THIRD way a comment becomes file-level, and it is local-mode only.**
The plan's pre-checks stop at HEAD drift, which settles the COMMITTED content.
The working tree is a separate question: local mode renders it, so a comment's
line number describes the file on disk, and an uncommitted edit above that line
shifts it. The shifted line still lands inside a hunk, so the existing
expanded-context check passes and GitHub renders the comment against the wrong
line, silently — the exact outcome decision 8 rejected for the READ side.
Refusing the whole submission over an unrelated dirty file would be worse (a
dirty tree is the normal state of a local review), so comments in locally-edited
files degrade to file level with a `(Ref Line N)` prefix. `filesWithLocalEdits`
is null in PR mode, whose worktree is pinned and never edited.

**Delta — the diff is a ROUTE input, and local mode's is the PR's diff, not the
session's.** GitHub validates every inline comment against the PULL REQUEST's
diff, so a line inside a narrow local scope but outside the PR would be posted
at a position GitHub cannot render. The local route therefore generates
`base...head` from the user's own checkout via the SAME
`GitWorktreeManager.generateUnifiedDiff` PR mode uses — sound because the
preconditions have just proved local HEAD IS the PR head. When the base commit
is not fetched locally it throws, and the established fallback applies: empty
diff, every comment file-level. The unanswerable-dirty-set case reuses that same
channel rather than inventing a second one.

**Delta — a comment on a file the PR does not touch is REFUSED, not degraded.**
The two are different failures and the plan conflated them. A comment outside
every hunk is a degraded ANCHOR — it still posts, at file level, with its line
in the text. A comment on a file the pull request never changed is a comment
GitHub will not take at all, inline or file-level, because the path is not part
of the diff — and a local scope routinely contains such a file (edited locally,
never committed). `GitHubClient.createReviewGraphQL` already handles it safely
(it deletes the pending review it created and throws), so the submission fails
either way; `filesNotInDiff` catches it first, costs no round trip, and names
the files instead of surfacing a nested GraphQL envelope. 409
`comments_outside_pr`, nothing consumed, the comments still there to act on.
An EMPTY diff answers nothing about any path, so the check is skipped there —
the same "unknown is not no" rule the file-level fallback follows.
`buildDiffLineSet` gained `hasFile` for it (additive; every existing caller
destructures `isLineInDiff`).

LOCAL MODE ONLY (`refuseCommentsOutsideDiff`), and the parity rule is what
decided it: applying it in both modes turned two PR-mode submit tests red, whose
fixtures comment on files absent from the mock diff. The honest distinction is
which diff the comments were authored against — PR mode's were written on the
PULL REQUEST's own diff, so a path outside it is an anomaly that route has never
refused and 5a may not start refusing; local mode's were written on the working
tree's, so the mismatch is routine.

**Two open questions, both about how far `hasFile` may be trusted as a REFUSAL
signal** (as opposed to a degradation signal, where a wrong answer costs only
precision):
1. Whether PR mode should adopt `refuseCommentsOutsideDiff` once someone
   confirms GitHub's exact answer for a file-level thread on an out-of-diff
   path.
2. Whether "every commented file must be part of the pull request" should be
   RELAXED under alt-host support (reviewer note, 2026-08-23 round — recorded,
   not actioned; no behaviour was changed for it). The refusal assumes the
   generated `base...head` diff is a faithful statement of what the pull request
   touches. That holds on github.com, where the base commit is normally
   fetchable and the diff is the same one the host validates against; a
   GitHub-compatible alt host is where the assumption is least examined, and a
   diff that could not be built the same way would turn a routine submission
   into a whole-submission 409. The safe direction if it does not hold is the
   one item 1 already contemplates in reverse — degrade rather than refuse.

**Delta — `SplitButton` is the one affordance that cannot re-read a late flip.**
Every other local-mode affordance re-reads `hasCapability` on each call
(the LATE FLIP half of the capability contract). `SplitButton` reads
`canSubmitToGitHub` in its CONSTRUCTOR and stores both `hideSubmit` and the
derived `defaultAction`, so `_refreshPRMetadata` re-runs `initSplitButton()` on
EITHER transition — gaining Submit has to reveal it, and losing it has to take
it away, or a force-push to unrelated history leaves a control that would POST
to a PR the session is no longer tied to.

**Delta — `PreviewModal` had to move with it.** It still gated Submit on
`window.PAIR_REVIEW_LOCAL_MODE`, so the preview modal would have hidden a button
the toolbar was showing for the same session. Same shape as every other defect
in this feature: one side of a two-sided contract updated, the other left on its
old assumption.

**Order matters in the local handler:** `review.local_path` may be null, and
`execSync` with `cwd: undefined` runs in the SERVER's working directory. The
precondition check runs first and refuses with `local_head_unknown` on a null
path, so neither `listFilesModifiedVsHead` nor `generateUnifiedDiff` is ever
reached with one.

**Tests** (measured after the 2026-08-23 round-2 fixes: `pnpm vitest run
tests/unit/ tests/integration/` → **10739 passed across 306 files**, zero
failures):
`tests/unit/review-submit.test.js` (102 — comment shaping incl. the dirty-file
and LEFT-anchor rules and `start_side` on multi-line ranges, the precondition
table incl. per-event lifecycle and read-failure classification, the write's
transaction boundary, id reuse, draft promotion, and the residue classifier
across all three outcomes), `tests/integration/local-submit-review.test.js`
(44 — the full refusal ladder against a real database, the snapshot gate incl.
every uncomparable status, the LEFT-anchor matrix, plus the write's DB effects),
`tests/unit/local-submit-affordance.test.js` (45 — endpoint indirection, both
modal gates, the split-button rebuild and its `_settleBeforeAction` flush, the
lifecycle option gate and the refusal-race recovery),
`tests/unit/headless-submit-review.test.js` (21 — the
`commentsOverride` seam: row selection, `formatAISuggestion` bodies, `headSha`
reaching the provider, the pinned stdout shape),
`tests/unit/local-review.test.js` (90 —
extended for `listFilesModifiedVsHead`, `GIT_DIFF_FLAGS` included),
`tests/unit/diff-line-set.test.js` (32) and `tests/unit/diff-annotator.test.js`
(54) — extended for hunkless `hasFile` sections and for the hunk-body/file-header
desync, `tests/unit/diff-paths.test.js` (30 — NEW: the three shapes git actually
emits, byte-level octal decoding, the `diff --git` split ranking),
`tests/unit/pr-lifecycle-badge.test.js` (19 — the single reconciler, both modes,
incl. the unknown/fail-open payloads that must not downgrade a merged PR),
`tests/e2e/local-submit-review.spec.js` (9),
`tests/unit/pr-context.test.js` + `tests/integration/routes.test.js` updated for
the flipped flag and the ambiguous-host capability. New behaviours
mutation-checked by reverting the production change and confirming the specific
test fails.

#### Review round (2026-08-23) — feedback applied

The round's through-line: **this phase inherited three "unknown is not no"
rules from Phases 2–4 and applied each of them one step short.** A refusal
collapsed four authoritative GitHub answers into one unknown; a trust gate
settled the RIGHT column and left the LEFT one unasked; a hardening flag was
proven necessary in one diff invocation and omitted from its newest sibling.

- **A settled pull request refused all four events (critical to the feature's
  point).** GitHub accepts a `COMMENT` review, and inline review comments, on a
  closed or merged PR — only `APPROVE` / `REQUEST_CHANGES` and a new pending
  review are meaningless once it is settled. The blanket 410 blocked legitimate
  post-merge feedback and was a gratuitous divergence from PR mode, which has no
  lifecycle check at all. `checkSubmitPreconditions` now takes the intended
  `event` and refuses per event; the route passes it. **An ABSENT event still
  refuses everything** — the comparison is against the literal `'COMMENT'`, so a
  caller that did not say what it intends does not get the permissive branch,
  and the original conservative behaviour is what an un-updated caller keeps.
  **The client got the same rule, and a recovery for the race it cannot avoid.**
  `ReviewModal.applyAllowedEvents` disables the three unavailable radios with
  the reason on them (disabled-with-an-explanation, matching the Draft
  textarea's idiom — a control that vanishes reads as a bug), driven by
  `PRManager.getPRLifecycle`, which resolves `pr.associatedPR || pr` so local
  mode reasons about the associated PR without mode-sniffing. An unknown
  `state` reads as null and is treated as OPEN: stripping Approve from a
  healthy PR whose metadata simply had not arrived is worse than letting the
  backend refuse. The PR can settle between `show()` and submit, so a
  `pr_merged` / `pr_closed` refusal is handled as a STATE RACE, not a user
  error — `handleLifecycleRefusal` PINS the refusal locally and re-applies the
  options synchronously (correct even if the follow-up refresh fails), then
  asks the manager to re-read lifecycle. The pin WINS over the manager's copy,
  because that copy is by definition the stale thing that produced the options
  just refused; it is cleared on `show()`, so a reopened PR gets its full set
  back.
- **The head check could not see the drift that matters most (critical).**
  `checkSubmitPreconditions` compares LIVE local `HEAD` with the PR head — a
  different question from "are the stored anchors still valid", and passing it is
  not evidence for that one. Comment, then commit and push: local `HEAD` is the
  PR head again, the PR-side check sees a perfectly aligned checkout, and every
  stored `(file, line, side)` is a coordinate in the pre-commit snapshot. The
  dirty-then-reverted tree is the mirror image — `HEAD` never moved, the content
  under the anchors did. New gate: `evaluateLocalSnapshotDrift` compares
  `reviews.local_head_sha` and the stored scoped-diff digest against the tree,
  refusing 409 `local_diff_stale`. **Extracted from `check-stale`, not written a
  second time** — the sequence is four steps deep (memory cache → DB fallback →
  cache warm → recompute) and every step has a way of saying "I don't know" that
  must not read as "nothing changed", so it returns a `status` alongside two
  PROVEN-difference booleans; only the booleans refuse. Runs BEFORE any GitHub
  call: no remote answer can fix a stale snapshot, and refusing first means no
  request (and no `token_command` shell-out) is made for a session about to be
  rejected. **It is a refusal, not a degradation**, and that is the whole
  distinction the section draws: `(Ref Line N)` is only meaningful while N
  describes the diff the reviewer was looking at — when the snapshot is stale the
  prefix text lies too, so there is nothing to degrade to.
- **The trust gate settled the RIGHT column only (critical).** Both existing
  file-level fallbacks — expanded context, dirty file — answer about RIGHT-side
  lines. A `side: 'LEFT'` comment's number was authored in the LOCAL diff's OLD
  coordinates while it is validated against the PULL REQUEST's `baseSha..headSha`
  diff; those are the same file only when the two bases are the same commit, and
  they diverge on a stacked PR, on a PR whose base changed on GitHub, and under
  the in-UI base-branch override (never persisted, so nothing downstream can
  notice it). **The trap is that check (2) does not fire:** `buildDiffLineSet`
  records a LEFT entry for every deleted AND context line, so almost any
  plausible number lands inside some left-side hunk and the comment posts
  silently against content nobody pointed at. `formatCommentsForGraphQL` gained
  `trustLeftAnchors` (default `true`, so PR mode — whose left column IS the pull
  request's — is unchanged), and the route computes the SAME predicate the read
  side uses: `scopeIncludesBranch && localMergeBaseSha === prData.base_sha`,
  mirroring `_externalAnchorContext` in public/js/pr.js and
  `_applyBaseOverrideLeftAnchor` in public/js/local.js. **The write path must
  never be more trusting than the read path** — the mismatch would mean the UI
  refuses to render a line it just posted to. Fails safe on every unknown, and
  it is per-comment: nothing about the RIGHT column is implicated.
- **Four authoritative GitHub answers were collapsed into one 502.**
  `fetchPullRequest` REJECTS with a `GitHubApiError` carrying `.status`; it does
  not resolve null. A blanket catch therefore turned "gone", "not yours", "no
  scopes" and "rate-limited" into `pr_state_unknown`, which tells the user to
  retry a request that cannot succeed and left the routes' own vocabulary
  (`auth_failed`, `insufficient_permissions`, `rate_limited`) unreachable from
  the pre-check. `classifyPRReadFailure` keys off the STATUS, never message
  text, and 502 `pr_state_unknown` is reserved for what it names: a transport
  failure or a response that genuinely settles nothing. **Fail-closed is
  untouched** — classification changes the code the user sees, never the verdict.
- **A partially-written review reported as an ordinary failure.**
  `GitHubClient` cleans up only the pending review it CREATED; when the review
  was a pre-existing draft it deliberately does not delete it (the draft is the
  user's and may hold earlier comments) and logs "comments may be partially
  added". `submitReview` then threw before touching a `comments` row, so every
  comment stayed `active` and a retry sent the SAME complete set into the SAME
  draft, duplicating whatever landed. `describePartialWriteRisk` re-labels it
  409 `partially_posted`, names the draft, and says to look before resubmitting.
  **The condition is STRUCTURAL, not the error text** — `createReviewGraphQL`
  flattens everything into one message, so matching on it would rot; "we reused
  someone else's draft AND we sent it comments" is exact, and covers the batch
  throwing, a partial batch, and the final submit mutation failing after all
  comments landed, because all three leave the same residue. With no draft or no
  comments, the original error passes through UNCHANGED so both routes' catch
  ladders keep classifying it as they do today. Durable reconciliation (a
  per-comment success identity) is a schema change and out of scope; not lying
  about the state is not.
- **`hasFile` was an alias for "has at least one hunk line".** It was populated
  from the hunk loop, so a file header that closes with no hunk body — a
  100%-similarity rename, `Binary files ... differ`, a mode-only change, an
  empty new file — registered no path. Every one of those IS a path the diff
  touches, and rename detection is ON (`GIT_DIFF_FLAGS` carries no
  `--no-renames`), so the shape is routine. The consequence was
  disproportionate: `refuseCommentsOutsideDiff` rejected the WHOLE submission,
  including its unrelated valid comments, over one file-level comment on a
  renamed file plainly in the pull request. `buildDiffLineSet` now closes each
  file SECTION and records `newPath || oldPath` — the same expression the hunk
  loop uses, evaluated after the `---`/`+++` refinements have landed. The two
  answers stay populated from different places on purpose; `isLineInDiff`
  remains hunk-keyed.
- **`listFilesModifiedVsHead` failed OPEN for a subdirectory `local_path`.** It
  was the one diff invocation in src/local-review.js without `GIT_DIFF_FLAGS`.
  Most of the set is inert under `--name-only`; `--no-relative` is load-bearing.
  With `diff.relative` configured and a `local_path` below the repo root, git
  returns SUBDIRECTORY-relative paths, none of which match the repo-root-relative
  `comment.file` the caller tests — so **every dirty file reads as clean and its
  comments KEEP line numbers that no longer describe the commit GitHub holds**.
  That is precisely the failure direction the function's THROWS-rather-than-empty
  contract exists to make impossible. A subdir `local_path` is reachable:
  src/routes/mcp.js and src/routes/analyses.js store the path they are given
  verbatim.
- **Finalising a draft left its own comments `draft` forever.** A `DRAFT`
  submission marks this review's active comments `draft`; finalising that same
  pending review later sends only the still-`active` ones — correct, the drafted
  ones are already on GitHub — but **GitHub submits the whole pending review**,
  drafted comments included. The finalising pass now promotes this review's
  `draft` rows to `submitted` in the SAME transaction with the SAME stamp (so one
  submission reads as one event), and folds `existingDraft.comments.totalCount`
  into the reported total. Order is immaterial: the loop only touches rows that
  were `active`, the statement only rows that were `draft`. Scoped to
  `source = 'user'` for the reason `loadSubmittableComments` is. **Skipped under
  `commentsOverride`** — a caller that supplied its own row set does not share
  this statement's predicate, and this function will not reach past the rows it
  was handed.
- **Test coverage added for the rungs nobody had exercised.** The fail-closed
  `host_binding_failed` rung (a stored host config no longer describes) with its
  positive twin proving an alt-host-stamped PR is submitted to the ALT host and
  not github.com — the negative alone would pass against a route that never
  reached GitHub at all. Ambiguous-host submit capability at the route level
  (`canSubmitToGitHub` withheld on an unresolved dual-host association,
  alongside `canSyncDrafts`), so the flag and the 409 the endpoint would return
  cannot disagree.
- **The headless `--ai-review` / `--ai-draft` path had hand-rolled its own copy
  of the write, and it had already drifted three ways.** Folded onto the shared
  provider: `src/main.js` now extracts `submitHeadlessAIReview`, which owns only
  what this flow knows — the AI-row query (`source = 'ai'`, orchestrated,
  active — NOT the reviewer's own comments), the `formatAISuggestion` bodies,
  the review body and its `--ai-draft`/`--ai-review` footer, and every line of
  stdout (this runs in CI; the shape is a contract, and it is pinned by test).
  All four reach the provider through ONE explicit input, `commentsOverride`
  (`{comments, status}`), rather than teaching `submitReview` to sniff for a
  mode: headless answers "which rows", "bodied by whom" and "what status after
  the write" (`options.commentStatus`) differently on all three counts.
  **`commentsOverride` also suppresses the draft-promotion statement above** —
  that statement's `source = 'user'` predicate is not this caller's predicate,
  and the provider must not reach past rows it was never handed. What headless
  CI gains: **alt hosts work at all** (it never sent `headSha`, so a
  GitHub-compatible host validating each inline comment like
  `pulls.createReviewComment` 422'd the whole submission on `missing commit_id`);
  an out-of-hunk AI suggestion degrades to a file-level `(Ref Line N)` comment
  instead of posting a position GitHub cannot render (a deliberate behaviour
  change, and the point of the fold); fuller `github_reviews` metadata (`event`,
  `submitted_at`, and `created_at` no longer stamped on a submitted review); and
  a `partially_posted` branch in the CLI catch ladder, matched on the CODE — the
  message embeds the underlying GitHub failure verbatim, so the substring ladder
  below it would happily misfile a "not found" or "rate limit" and tell a
  retrying CI job to do the one thing that duplicates every comment that landed.
  `trustLeftAnchors` is deliberately NOT passed: every row built here is
  `side: 'RIGHT'`, so the gate is unreachable and the provider's default is the
  correct answer rather than an assumed one. `filesWithLocalEdits` is `null`,
  PR-mode semantics — the pool worktree is created for this PR and nobody edits
  it. The diff handed down is the very one this run was ANALYSED against, the
  `diff` local assigned unconditionally in both arms of `performHeadlessReview`'s
  checkout branch, so headless can never silently submit against an empty diff.
- **Residual, NOT a regression — headless draft rows are never promoted.**
  `--ai-draft` lands its AI rows at `status = 'draft'`; a later `--ai-review`
  loads only `status = 'active'` rows, and GitHub submits the whole pending
  review including the drafted ones. The promotion statement that fixes exactly
  this for the web routes cannot help: it is `source = 'user'`-scoped AND
  suppressed under `commentsOverride`. So the local rows stay `draft` while the
  host shows them published. Pre-existing (the old hand-rolled write had no
  promotion either), and out of scope for a fold that must not change stdout or
  row semantics — but worth a follow-up, and the fix is the same shape: a
  promotion the override caller performs over its OWN predicate.

**README:** the feature section was rewritten for this round — the preflight
list no longer claims a count (it was three, then four, now five), the lifecycle
bullet states the per-event rule and the modal's greyed-out options and
refusal-race recovery, `local_diff_stale` is documented as a refusal in the
position it runs, the LEFT-side rule joins the degradations (not the refusals —
the section draws that line sharply and the new material keeps it),
`partially_posted` is documented as neither, and the token sentence now
separates read-only PR context from Submit review's **Pull requests: Read and
write**, with the fine-grained equivalent added to the GitHub Token section,
which had listed classic scopes only.

#### Review round 2 (2026-08-23) — feedback applied

The round's through-line: **round 1 hardened four refusals, and the newest of
them was the one that failed OPEN.** The rest of the round is the same shape as
the integration round of 2026-08-19 — a rule applied to one half of a shared
contract. A LEFT-anchor gate that trusted a base nothing records; a start
coordinate whose side defaults independently of the end's; a residue guess made
from outside the write that reports it; a capability flush that lands after the
action it exists to suppress.

- **The snapshot gate failed open — the one gate in the feature that did
  (critical).** `evaluateLocalSnapshotDrift` returns a `status` alongside two
  PROVEN-difference booleans precisely because three of its statuses answer
  nothing (`no-stored-diff`, `no-baseline-digest`, `digest-unavailable`), and
  the submit route read only the booleans. All three leave both flags false, so
  all three read as "compared, and clean" and AUTHORISED THE WRITE — the exact
  inversion of "unknown is not no" that every other check in this feature had
  already been fixed for. `src/routes/local.js` now proceeds only on
  `status === 'compared'` with both flags false; every other status is 409
  `local_diff_unverified`, carrying `snapshotStatus` for logs and for a client
  that has not heard of the specific value. One code for all three because the
  remedy is one thing — refresh the diff. **This is a refusal, not a
  degradation**, for the round-1 reason: `(Ref Line N)` is only worth writing
  while N describes the diff the reviewer saw.
- **LEFT anchors degrade UNCONDITIONALLY in local mode (critical).** Round 1's
  gate computed `scopeIncludesBranch && localMergeBaseSha === prData.base_sha`
  and granted precision when it held. The predicate is unprovable: it compares
  the review's CURRENT persisted base against the PR base, while the question is
  which base the reviewer was looking at WHEN THEY WROTE THE COMMENT. Two
  routine transitions break it — a comment authored under a transient in-UI base
  override, and a comment authored before `set-scope` moved the stored base —
  and **neither touches the working tree, so the snapshot digest cannot see
  either one.** The merge-base computation is deleted; the route passes
  `trustLeftAnchors: false` always. PR mode's default (`true`) is untouched: its
  left column IS the pull request's. **The provenance fix is DEFERRED, and
  deliberately linked to the migration blocker at the top of this plan** — the
  correct long-term answer is to persist each LEFT comment's authored old-side
  base sha and keep precision only while it equals the live PR base, which is a
  schema change, and this branch already carries an unresolved
  migration-number collision. Adding a 58 now compounds it. Degrading costs
  precision and never correctness, and tightening later is a pure widening.
- **`parseFileHeader` ran on hunk body lines (critical, pre-existing, escalated
  by this branch).** Inside a hunk body those prefixes are content: a deleted
  `-- note` is emitted as `--- note`, an added `++ marker` as `+++ marker`, an
  unindented `++i;` as `+++i;`. Each was swallowed as a file header, so the
  recorded path became a fragment of source and — because the swallowed lines
  were never counted — **every LEFT/RIGHT line number after it in that file was
  off by one.** Both `buildDiffLineSet` and `annotateDiff` now establish
  hunk-body state first, with an `isBareFileSectionStart` carve-out for diffs
  that carry no `diff --git` line at all and separate files with only the
  `---`/`+++`/`@@` triple. The escalation is this branch's:
  `refuseCommentsOutsideDiff` turned a file that "looked absent from the diff"
  from a file-level downgrade into a 409 refusing the WHOLE review.
- **`src/utils/diff-paths.js` (NEW) — one canonical git path parser.**
  `diff-annotator.js` and `diff-file-list.js` each had their own, and they
  disagreed: one kept the bare TAB git appends to a name containing a space,
  neither decoded C-quoted names (`"a/caf\303\251.txt"`), and the greedy regex
  took the LAST `" b/"` split candidate where the other took the first. A
  one-byte disagreement between them is not cosmetic here — `hasFile()` decides
  whether a comment is REFUSED while `parseUnifiedDiffPatches` decides which
  patch the UI renders it against, so a file plainly visible in the diff became
  a file the submitter said was not in it. Octal escapes are decoded at the BYTE
  level (`\303\251` is two bytes of "é", not two characters); `unquoteGitPath`
  is exported separately because the same quoting governs `git diff
  --name-only` and `git ls-files`.
- **`startSide` was never sent for a multi-line LEFT range (critical).**
  GitHub's `AddPullRequestReviewThreadInput` defaults `side` and `startSide` to
  RIGHT **independently**, so a range that declared only `side: LEFT` asked for
  a thread ending on the old column and starting on the new one — a coordinate
  pair that means nothing, rejected outright or anchored somewhere nobody
  pointed at. Both endpoints were already validated against the same side a few
  lines earlier, so the same side is the only honest answer. Fixed in
  `formatCommentsForGraphQL` and in the GraphQL transport
  (`src/github/impl/graphql/pending-review-comments.js`); the REST-shaped host
  transport already paired `start_side` with `start_line`.
- **Write residue is REPORTED by the write, not guessed from outside it.** Round
  1's structural test — `existingDraft && sentComments > 0` — was wrong in both
  directions. An auth failure or a rate limit at the very first batch writes
  NOTHING, yet was relabelled 409 `partially_posted`, burying the routes'
  actionable 401/429 under a blanket "do not retry"; and it stayed SILENT when
  the review was newly created, even though cleanup only ever covered the
  comment phase — a failure of the FINAL SUBMIT mutation left a pending review
  holding every comment, unwarned. `GitHubClient` now stamps every flattened
  failure with `error.reviewWriteProgress` (phase, confirmed comment count,
  whether that count is exact, whether the review pre-existed, whether cleanup
  succeeded) and the submit phase DELETES a review it created, so that retry is
  clean. `assessWriteResidue` reads the report: `null` (original error
  propagates unchanged, each route keeps its own classification),
  `reused_draft`, or `orphaned_review`. "May have written" counts as residue —
  a transport that throws mid-flight may have had its request applied and only
  lost the response. The old guess survives as the fallback for an
  uninstrumented client, because it errs toward warning.
- **`SplitButton` flushed the revoked capability AFTER acting on it.** The
  deferred `hideSubmit` flush ran in the dispatcher's trailing
  `closeDropdown()`, so a click on a Submit row the flush was about to remove
  still opened the review modal AND still persisted `submit` as the default
  action to localStorage — outliving the session that revoked it.
  `_settleBeforeAction` flushes first, re-validates against the SETTLED state,
  and swallows the click with a toast rather than silently; both dispatchers
  (main button and menu row) go through it, because the main button stays
  clickable while the dropdown is open.
- **One lifecycle reconciler for both modes.** `_applyPRHeadStaleState` in
  `public/js/local.js` carried a hand-copied twin of `_applyPRLifecycleBadge`
  and had already drifted from it field by field: it converted an unreported
  `merged` to `false` and CLEARED the badge on an unreported `state`, so one
  fail-open staleness response could un-merge a known-merged PR — dropping the
  MERGED badge and, now that `getPRLifecycle` feeds the modal off exactly these
  two fields, handing Approve back to a review the backend will refuse. Local
  mode now delegates to the single implementation, through
  `lifecycleFromStaleness`, which drops a fail-open payload before it reaches
  the reconciler. Unknown is not open, and it is not "not merged" either.
- **DECISION (user, 2026-08-23): the shared modal's per-event lifecycle gate
  STAYS IN BOTH MODES, and is documented as a PR-mode change.** The reviewer
  flagged it as local-mode policy leaking into PR mode. It is not: the policy is
  GitHub's — Approve on a merged pull request fails on the host whoever asks —
  so one modal enforcing it in both modes is the correct shape. GitHub remains
  the authority; the client gate is an affordance, and a stale lifecycle copy
  just means the host refuses exactly as it did before. **No live backend
  lifecycle check is added to PR mode's submit route** (`src/routes/pr.js` still
  calls no `checkSubmitPreconditions`), so the asymmetry that remains is
  deliberate and is the one the README now states.
- **The changeset stopped claiming "PR mode is unchanged."** It changes in three
  places and all three are now named there: the shared modal's greyed-out
  options, the residue classification (a failure that wrote nothing keeps its
  own status; one that left comments is a 409 naming the review), and the
  draft-promotion statement. The third is a CORRECTNESS fix in both modes, not a
  regression — the rows had diverged from what GitHub actually holds, because a
  `DRAFT` pass marks its comments `draft` locally and does not resend them,
  while GitHub publishes the whole pending review on finalisation.

**README:** three paragraphs corrected. The snapshot bullet now refuses an
*uncomparable* snapshot on the same terms as a drifted one, with the same
one-click remedy and the note that refreshing keeps your comments. The lifecycle
bullet no longer says PR review mode has no lifecycle check — round 1 wrote that
as a contrast and the shared modal made it false; it now states where the
enforcement actually lives in each mode. The LEFT-side paragraph drops the
"unless the bases provably agree" clause and says why agreement cannot be proven
after the fact.

## Hazards

**Shared functions modified or to-be-modified (list every caller before changing):**
- `detectPRForBranch` (`src/local-review.js`, post-Phase-0) — callers: (1) CLI `handleLocalReview`, (2) web UI `POST /api/local/start`, (3) `GET /api/local/:reviewId` background backfill. Any signature change must touch all three.
- `detectAndBuildBranchInfo` (`src/local-review.js`) — still used for CLI scope-suggestion UX. Does NOT do PR persistence anymore; that moved to `detectPRForBranch`.
- `getReviewByPR` (`src/database.js`) — filtered to `review_type='pr'`. 8 callers; all expect PR rows. Do not relax the filter.
- `isPRMode` (`src/routes/external-comments.js:101`) — callers: (1) the sync route `:291`, (2) the fetch route `:397`. Phase 2 replaces it with a target resolver; both callers must move together, and they must keep their *different* null responses (sync 400, fetch empty threads).
- `executeSync` (`src/routes/external-comments.js:123`) — reads `review.repository` / `review.pr_number` at `:132`, `:147`, `:166`. Phase 2 routes all three through the resolver; miss one and an associated-PR sync silently targets `undefined/undefined`.
- `_loadExternalComments` (`public/js/pr.js:1203`) — callers: PR init wiring, `refreshPR`, and the post-diff-rebuild re-render at `:1131`. Phase 2 swaps its local-mode bail for a capability check; all three callers inherit the change.
- `check-stale` endpoints in BOTH `src/routes/local.js` AND `src/routes/pr.js`. Phase 3 refactor must produce identical outputs for the existing inputs.
- `syncPendingDraftFromGitHub` — extracted to `src/providers/draft-sync.js` in Phase 4, signature unchanged, still re-exported from `routes/pr.js` `_internals`. Callers: (1) `GET /api/pr/:owner/:repo/:number` (direct), (2) `GET .../github-drafts` (now via `syncPendingDraft`), (3) `POST /api/local/:reviewId/sync-drafts` (via `syncPendingDraft`). Any signature change must touch all three.
- `updatePendingDraftIndicator` (`public/js/pr.js`) — shared with local mode since Phase 4. Callers: `renderPRHeader` x2 (PR), `ReviewModal.submitReview` x2 (PR), `LocalManager._syncGitHubDrafts` (local), `LocalManager._updateDraftSyncAffordance` (local, the null/clear call). The URL comes from `RepoLinks.draftUrl`, shared with `ReviewModal.updatePendingDraftNotice`; it is only host-correct because local mode feeds RepoLinks the association's `{number}` (`_applyRepoLinks`). Changing one of those three without the others reintroduces a repository-level link for a draft.
- `GitHubReviewRepository.upsertFromGitHub` (`src/database.js`) — the ONE writer for a mirror row with a GitHub identity, because migration 57 makes a duplicate a hard error. Callers: draft sync (`src/providers/draft-sync.js`), `POST /api/pr/.../submit-review` (`src/routes/pr.js`), headless submit (`src/main.js`). Any new `github_reviews` insert carrying a node id or numeric id must go through it — a bare `create` will throw the moment the same review is seen twice (draft, then submit).
- `resolveAssociationHost` (`src/routes/local.js`) — the two-tier host answer. Callers: `GET /api/local/:reviewId` and `/pr-metadata` (both feed `buildCapabilities.hostResolved`) and `POST /api/local/:reviewId/sync-drafts` (the 409 gate, which also re-resolves the binding for a stamped host). A capability looser than the gate advertises a button that only errors; a gate looser than the capability contacts a guessed host.
- `submitReview` (`src/providers/review-submit.js`, Phase 5) — the GitHub review WRITE. THREE callers: (1) `POST /api/pr/:owner/:repo/:number/submit-review` (`src/routes/pr.js`), (2) `POST /api/local/:reviewId/submit-review` (`src/routes/local.js`), (3) the headless `--ai-review` / `--ai-draft` flow, via `submitHeadlessAIReview` (`src/main.js`). All three hand it already-resolved inputs (credential, PR node id, head sha, diff, host name); it resolves no config and reads no `pr_metadata`. Anything added to it lands in ALL THREE — which is the point, and also the hazard: PR mode's response body is asserted byte-for-byte by tests/integration/routes.test.js, and headless's STDOUT shape is a CI contract pinned by tests/unit/headless-submit-review.test.js. Caller (3) is the only one that supplies `commentsOverride`, which switches off both the default row query and the draft-promotion statement — a change to either must state what it means for an override caller.
- `formatCommentsForGraphQL` (`src/providers/review-submit.js` `_internals`) — decides line-level vs file-level for every submitted comment. FOUR independent degradations feed it (explicit file-level, outside-the-diff, locally-edited file, untrusted LEFT anchor) and the diff itself is a caller input. A caller that passes a diff which is not the PULL REQUEST's diff silently posts positions GitHub cannot render; a caller that passes an empty `filesWithLocalEdits` set when it does not KNOW asserts the working tree is clean; a caller that passes `trustLeftAnchors: true` without proving the two bases agree asserts a left column it has not checked — and round 2 established that local mode CANNOT prove it, so the local route passes `false` unconditionally and only PR mode's default `true` remains. It also emits `start_side` beside `start_line`: the two endpoints of a range default their side INDEPENDENTLY on GitHub, so any new range-shaping code must set both or ask for a mixed-side range.
- `buildDiffLineSet` / `annotateDiff` (`src/utils/diff-annotator.js`) — two parsers walking the same diff text with the same file-header, hunk-header and line-counter logic, and every fix must land in BOTH: they diverged once already and produced different `hasFile` answers for the same input. Since round 2 they share `parseFileHeader`'s hunk-body guard, `isBareFileSectionStart`, and — with `parseUnifiedDiffPatches` in `src/utils/diff-file-list.js` — the one path decoder in `src/utils/diff-paths.js`. **No new diff parser may spell a path for itself.** `hasFile()` decides whether local mode REFUSES a whole submission while `parseUnifiedDiffPatches` decides which patch the UI renders that comment against; a one-byte disagreement (a trailing TAB, surviving quotes, an undecoded octal escape) makes a visible file an absent one.
- `evaluateLocalSnapshotDrift` (`src/routes/local.js`) — callers: `GET /api/local/:reviewId/check-stale` (reports) and `POST /api/local/:reviewId/submit-review` (AUTHORISES A WRITE). Its `status` is not decoration: three values (`no-stored-diff`, `no-baseline-digest`, `digest-unavailable`) answer nothing while leaving both PROVEN-difference booleans false. A caller that reads only the booleans reads "unknown" as "clean" — which is exactly how round 1 shipped it. Any new caller must decide what an uncomparable snapshot means for IT before it touches the flags.
- `_applyPRLifecycleBadge` + `lifecycleFromStaleness` (`public/js/pr.js`) — THE single lifecycle reconciler for both modes since round 2; local mode's `_applyPRHeadStaleState` (`public/js/local.js`) delegates to it rather than carrying its own copy, which is what drifted. Callers: `_checkStalenessOnLoad`, `refreshPRLifecycle`, `refreshPR` (PR) and `_applyPRHeadStaleState` (local). It writes back into `currentPR.associatedPR || currentPR` — the same target `getPRLifecycle` reads — so the badge and the modal's allowed events cannot disagree, and it ends by calling `updateSubmitAffordance`, so neither mode can forget to repaint. Two invariants: `merged` is checked BEFORE `state` (GitHub reports a merge as `state: 'closed'` + `merged: true`), and a payload that REPORTS neither field is dropped whole rather than written as false — never pick fields off a fail-open staleness response by hand, pass it through `lifecycleFromStaleness`.
- `ReviewModal.applyAllowedEvents` / `PRManager.getPRLifecycle` (`public/js/`) — the client half of the per-event lifecycle rule, and it runs in BOTH MODES by decision (see round 2): the modal is shared and the policy is GitHub's. Callers of `applyAllowedEvents`: `show()`, `PRManager.updateSubmitAffordance` (fires while the modal is open), and `handleLifecycleRefusal`. It must stay idempotent and re-entrant, and `getPRLifecycle` must keep reading `pr.associatedPR || pr` so local mode reasons about the ASSOCIATED PR. An unknown `state` reads as null and must be treated as OPEN by every consumer — guessing "closed" from missing metadata takes write actions away from a healthy pull request.
- `PRManager.getSubmitReviewEndpoint` (`public/js/pr.js`) — overridden in `LocalManager.patchPRManager`. Sole consumer: `ReviewModal.submitReview`. It is what keeps the shared modal free of mode-sniffing; a new submit entry point must ask the manager rather than rebuild a URL.
- `PreviewModal.show` / `SplitButton` constructor (`public/js/components/`) — both now read `canSubmitToGitHub`. `SplitButton` reads it ONCE and stores `hideSubmit` + `defaultAction`, so it is the only affordance that must be REBUILT on a late capability flip (`_refreshPRMetadata` re-runs `initSplitButton`); every other one re-reads the capability per call. A rebuild arriving while the dropdown is open is DEFERRED (`_pendingHideSubmit`), so both dispatchers must flush through `_settleBeforeAction` BEFORE they act — the old order acted on the answer the flush was holding, which is the answer that revoked it. Any new action added to this component inherits that requirement.
- `buildCapabilities` (`src/providers/pr-context.js`) — every phase flips one action flag. Forgetting to flip silently disables the feature with no error. Verify flag flips in each phase's integration test.

**Async races:**
- PR detection is async over GitHub API. If user refreshes mid-detection, `/api/local/:reviewId` may return `hasAssociatedPR: false` then `true` on next poll. Frontend must tolerate capability flags appearing later (re-render, don't latch).
- PR can be **closed or merged** between session start and Phase 5 submit. Provider must check PR state at submit time, not at capability-flag time. 410 + clear error, but PER EVENT: a settled PR still takes a `COMMENT` review, so only APPROVE / REQUEST_CHANGES / DRAFT refuse. The modal derives its options from a lifecycle copy that can be equally stale, so the 410 doubles as the signal that re-syncs it (`handleLifecycleRefusal`).
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
4. **PR association columns:** Separate (`associated_pr_number`, `associated_pr_repository`) — not the PR natural key. Migration 56.
5. **Capability shape:** Split into prerequisite state + action contracts. Action flags hard-false in local mode until each phase ships.
6. **Background backfill caching:** Per-process Map, 5-min TTL. No external invalidation in Phase 0.
7. **External comments are review-scoped, not route-scoped (Phase 2):** no `src/providers/pr-comments.js`, no `/api/local/:reviewId/pr-comments`. Local mode reuses `/api/reviews/:reviewId/external-comments[/sync]` with an association-aware target resolver. The provider-extraction rule in principle 1 is satisfied — the shared logic is already out of `routes/pr.js`.
8. **Anchor trust in local mode (Phase 2):** precise `(file, line, side)` anchoring only when local `HEAD === head_sha`. On drift, every thread degrades to the file-level fallback with a provenance note. No content-based re-anchoring in v1.
   **Amended twice.** First: that comparison alone is insufficient — both operands are page-load snapshots, so a PR advancing mid-session still reads as a match. A second, per-comment gate compares each row's own `commit_sha` (delivered fresh with the sync, cached nowhere) against the commit the rendered diff IS. Armed in local mode only. Both gates fail safe; PR mode is unchanged. Second (Phase 5, round 2): on the WRITE side there is no gate at all — a LEFT-side comment submitted from local mode always degrades to file level, because the base it was authored against is not recorded and therefore cannot be shown to match the pull request's. Restoring precision needs that provenance column, which needs a migration, which waits on the blocker at the top of this plan.
9. **`isStale` is working-tree-only, forever (Phase 3):** the local stale check's `isStale` answers ONE question — does the working tree still match the captured diff. PR-head drift ships beside it in `prHead` + `reasons[]` and must never be OR-ed in. `public/js/local.js` calls `refreshDiff({ silent: true })` whenever `isStale === true` and the session holds no user data; a refresh re-captures the working tree and can do nothing about a PR that advanced on GitHub, so folding drift in would mean a silent re-capture on every page load, forever, that never clears the condition that triggered it. The badge follows the same split: working-tree staleness wins the slot because it is the only one the refresh button fixes.
10. **Migration numbering (2026-08-23):** this branch lands against whatever `main` is at the time; its 56/57 are provisional and get renumbered during the rebase, with `CURRENT_SCHEMA_VERSION` bumped to match. No coordination with any other branch is assumed. **See the rebase note at the top of this plan** — once a database is stamped, a renumber alone stops being a sufficient fix.
11. **The per-event lifecycle gate applies in BOTH modes (2026-08-23):** the shared `ReviewModal` disables Approve / Request Changes / Save as Draft on a settled pull request in PR mode as well as local mode. The policy is GitHub's, not local mode's, so one modal enforcing it is correct rather than leakage; GitHub stays the authority and a stale client copy just means the host refuses, as before. **No live backend lifecycle check is added to PR mode's submit route** — the asymmetry is deliberate and documented in the README.

#### Integration review round (2026-08-19) — cross-boundary defects

Six agents implemented the review-round fixes in parallel across disjoint files; each verified its own file, so a follow-up read-only pass checked the seams BETWEEN them. Eight contracts checked out clean (anchor-context shape, the backend leg of the LEFT-trust plumbing, the pre-refresh hook, the context-file return shapes, `anchorNote` on both ChatPanel builders, the recovery response shape, the `?refresh=1` param and its intact `hostAmbiguous` refusal, and the host-option shape). The defects it found were all in the wiring, and the two most severe were regressions introduced by the review-round fixes themselves — worth recording, because both are the same shape: **a fix applied to one side of a two-sided contract.**

1. **Deriving the host on the READ side removed the net that was covering a WRONG WRITE side.** Both PR-association writers (`POST /api/local/start`, and `setupLocalReviewSession` on the CLI path) still bound the github.com guess and persisted a host-blind `associated_pr_number`. Previously the read side re-derived that same guess and stamped `hostAmbiguous`, so `fetchPRMetadata` refused and nothing was shown. With the read side now resolving concretely from the git remote, the refusal no longer fires — so a dual-host repo whose branch exists on BOTH hosts could discover PR #N on github.com and then read PR #N from the alt host, which is an unrelated PR. Strictly worse than the bug the fix was for. **Invariant now enforced and commented: detection and metadata-fetch must resolve the host through the same function, so a PR can never be discovered on one host and read from the other.**
2. **The capability recovery flipped the feature on without syncing.** `_refreshPRMetadata` ended with a GET-only re-render, but on the dirty-tree first load the `external_comments` mirror has never been populated (the initial sync bailed on the then-false capability), so the External segment appeared and was empty until a manual refresh. Nothing anywhere performed a sync after a late capability flip. The recovery now syncs on the false→true transition only.
3. `_refreshPRMetadata`'s success predicate folded `canViewPRComments` (association + token, independent of metadata) into the pill's retry latch, so one transient GitHub 5xx hid the PR pill for the whole session. Latch and progress are now separate answers.
4. The base-branch selector rebuilt the diff without refreshing the LEFT-anchor inputs, leaving `trustLeftAnchors` true against a base the diff no longer shows — the same "line found, wrong content" failure the gate exists to prevent, reintroduced through the one rebuild path that has no merge-base to adopt. It now fails safe to unknown.
5. `?refresh=1` bypassed the metadata backoff but not the PR-*detection* negative cache, so one failed probe made the association unrecoverable in-page for five minutes.
6. `hasGitHubToken` counted only the global token when a review had no association yet, making the recovery endpoint unreachable for exactly the repo-scoped-credential users the host work targets.
7. Smaller: the discarded ambiguity-rule resolve ran the user's `github_token_command` (5s) on the blocking page-load path for repos that end up alt-host-bound; the warm latch was released before a header re-render that immediately re-triggered it; `ensureContextFile(file, anchor, anchor)` requested a one-line context window (the ±10 centring only happens when the end is null); and the chat gate's "byte-identical in PR mode" comment was wrong — a genuinely file-level comment now gains a `Scope: File-level comment` line, which is a correction, not a regression.

**Lesson for later phases:** every fix in this feature has two sides — a producer and a consumer, or a writer and a reader — and the dangerous failures came from fixing one side while the other kept its old assumption. When a safety check is REMOVED because the underlying value became trustworthy, verify every writer of that value, not just the reader.
