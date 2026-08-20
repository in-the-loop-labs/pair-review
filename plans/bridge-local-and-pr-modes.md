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
- **Migration-number collision, external but lands here:** branch `claude/strange-hofstadter-d11581` (resolved external comments, `is_resolved` column) also claims **migration 56** — same number as this branch's Phase 0, both sitting on v5.1.0 — and it rewrites parts of this same subsystem. Whichever lands second renumbers and re-runs. Settle land order before starting Phase 2.

Changeset: `minor` — "Show existing PR review comments inline in local reviews."

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
- `isPRMode` (`src/routes/external-comments.js:101`) — callers: (1) the sync route `:291`, (2) the fetch route `:397`. Phase 2 replaces it with a target resolver; both callers must move together, and they must keep their *different* null responses (sync 400, fetch empty threads).
- `executeSync` (`src/routes/external-comments.js:123`) — reads `review.repository` / `review.pr_number` at `:132`, `:147`, `:166`. Phase 2 routes all three through the resolver; miss one and an associated-PR sync silently targets `undefined/undefined`.
- `_loadExternalComments` (`public/js/pr.js:1203`) — callers: PR init wiring, `refreshPR`, and the post-diff-rebuild re-render at `:1131`. Phase 2 swaps its local-mode bail for a capability check; all three callers inherit the change.
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
4. **PR association columns:** Separate (`associated_pr_number`, `associated_pr_repository`) — not the PR natural key. Migration 56.
5. **Capability shape:** Split into prerequisite state + action contracts. Action flags hard-false in local mode until each phase ships.
6. **Background backfill caching:** Per-process Map, 5-min TTL. No external invalidation in Phase 0.
7. **External comments are review-scoped, not route-scoped (Phase 2):** no `src/providers/pr-comments.js`, no `/api/local/:reviewId/pr-comments`. Local mode reuses `/api/reviews/:reviewId/external-comments[/sync]` with an association-aware target resolver. The provider-extraction rule in principle 1 is satisfied — the shared logic is already out of `routes/pr.js`.
8. **Anchor trust in local mode (Phase 2):** precise `(file, line, side)` anchoring only when local `HEAD === head_sha`. On drift, every thread degrades to the file-level fallback with a provenance note. No content-based re-anchoring in v1.
   **Amended during implementation:** that comparison alone is insufficient — both operands are page-load snapshots, so a PR advancing mid-session still reads as a match. A second, per-comment gate compares each row's own `commit_sha` (delivered fresh with the sync, cached nowhere) against the commit the rendered diff IS. Armed in local mode only. Both gates fail safe; PR mode is unchanged.

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
