# Lazy Diff-Body Rendering — Fix Large-PR Performance

## Context

Pair-review's performance is awful on very large PRs (the trigger case: `shop/world#773906`
— 303 changed files, ~5,900 changed lines, **350+ large translation files**). The root
cause is in the frontend render path, not the backend.

`renderDiff` (public/js/pr.js:3046) loops over **every** changed file and synchronously calls
`renderFileDiff` → `renderPatch` → `DiffRenderer.renderDiffLine`. The critical waste:
`renderFileDiff` (pr.js:3085) computes `isCollapsed` for generated/viewed files (pr.js:3097)
but **still builds the full `<tbody>`** at pr.js:3220-3221 — the `.collapsed` class only hides
the body via CSS (`display:none`, pr.css:1665-1668). And `renderDiffLine` (diff-renderer.js:295)
creates ~6 DOM nodes **and** calls `window.hljs.highlight()` **synchronously per line**
(diff-renderer.js:443-459). So 350+ collapsed translation files get fully materialized and
syntax-highlighted on load, in one un-yielded loop — freezing the browser.

**Goal:** render file bodies lazily — only when a file is on/near screen, expanded, or needs to
be anchored into — so collapsed/off-screen files cost nothing until needed. This is the
dominant win. (A separate, deferred backend cleanup is captured in the Appendix.)

This change lives in the **shared** PRManager render pipeline, so both PR mode and Local mode
inherit it. Both-mode parity is a hard requirement (see CLAUDE.md).

## Approach

Lazy-render the `<tbody>` of diff lines per file:

- `renderFileDiff` builds the wrapper + header + file-comment zone + an **empty** `tbody`/
  `fileBody`, stashes the render inputs (`patch`, `fileName`, `hunk_hashes`) in a
  `_lazyFileBodies` Map, and registers the `fileBody` with an `IntersectionObserver`. It does
  **not** call `renderPatch`.
- An `IntersectionObserver` watches each `.d2h-file-body`. Because `.collapsed` sets the body
  to `display:none`, collapsed bodies have no layout box and **never intersect** — they stay
  unrendered until expanded. Expanded-but-offscreen bodies render as they approach the viewport
  (via `rootMargin` pre-render).
- `ensureFileBodyRendered(fileOrWrapper)` is the on-demand escape hatch (idempotent, returns a
  Promise) used by every code path that scans `<tr>` rows. The existing
  `ensureLinesVisible` funnel already runs before comment/suggestion anchoring, so most anchor
  paths are covered by hooking into it; the few that bypass it get explicit hooks.

**Why not also chunk highlighting now?** Lazy file-body rendering bounds rendered rows to
~visible files, so the per-line `hljs` cost is no longer aggregated across 303 files. A single
huge expanded file could still be slow, but that's rare and out of scope here — noted as a
future lever, not blocking.

## Critical files

- `public/js/pr.js` — `renderDiff` (2992), `renderFileDiff` (3085), `renderPatch` (3251),
  `_kickOffHunkSummaries` (1091), `_applyHunkSummaries` (1227), `_renderOneSummary` (1308),
  `ensureLinesVisible` (4222), `expandForSuggestion` (4132), `toggleFileCollapse` (3577),
  `toggleFileViewed` (3603), `validatePendingEofGaps` (3776), `scrollToFile` (5904).
- `public/js/modules/suggestion-manager.js` — `displayAISuggestions` (~243),
  `findHiddenSuggestions` (~188).
- `public/js/local.js` — verify-only: `loadLocalDiff` (1525), `handleWhitespaceToggle` (473),
  `_applyScopeResult` (1560) / `_handleScopeChange` (1620) / `showBranchReviewDialog`.
- `public/css/pr.css` — confirm `.collapsed .d2h-file-body { display:none }` (~1665) and which
  element is the vertical scroll root (`.diff-view`, ~1685) → sets the observer `root`.
- `tests/e2e/helpers.js` (`waitForDiffToRender`) + `tests/e2e/global-setup.js` (mock fixtures).

## Implementation steps (ordered)

### Phase A — Core lazy mechanism (pr.js; shared by both modes)
1. **Constructor state** (near pr.js:143-154): add `this._lazyFileBodies = new Map()`,
   `this._fileBodyObserver = null`, `this._summariesByHash = new Map()`.
2. **`renderDiff`** (2992): keep existing resets (innerHTML clear 3007, summary-state resets +
   `_renderGen++` 3009-3027). Add: `_teardownFileBodyObserver()`, recreate
   `_fileBodyObserver = _createFileBodyObserver()`, fresh `_lazyFileBodies`/`_summariesByHash`
   Maps. **Remove** the global `validatePendingEofGaps()` at 3055 (moves per-file). **Replace**
   the one-shot `_kickOffHunkSummaries()` (3066) with `_fetchHunkSummaryMap()`.
3. **`renderFileDiff`** (3085): unchanged through header/comment-zone/buttons. Then build an
   **empty** `table`/`tbody`/`fileBody` (no `renderPatch`). For **expanded** files only
   (`!isCollapsed`), set a placeholder `fileBody.style.minHeight` ≈
   `(file.patch.split('\n').length) * APPROX_LINE_PX` (~20px) to keep the scrollbar stable;
   collapsed bodies are `display:none` so need none. Register a `_lazyFileBodies` entry
   `{ fileName, patch, hunkHashes, fileBody, wrapper, rendered:false, renderPromise:null, gen:this._renderGen }`,
   then `_fileBodyObserver.observe(fileBody)` (gated on `file.patch || file.binary`).
4. **`_createFileBodyObserver()`**: `new IntersectionObserver(cb, { root: <.diff-view or null>, rootMargin:'800px 0px', threshold:0 })`.
   On intersect: resolve entry from `entry.target`, call `_renderFileBodyNow(lazyEntry)`, then
   `unobserve`.
5. **`_teardownFileBodyObserver()`**: `disconnect()` + null (called at top of `renderDiff`;
   `innerHTML=''` detaches observed nodes, so a stale observer must be dropped).
6. **`ensureFileBodyRendered(fileOrWrapper)`** → Promise: resolve entry (string→Map lookup;
   element→`dataset.fileName`→lookup). `null` if unknown (legacy/already-rendered/binary). If
   `entry.rendered` → resolve `entry.fileBody`. If `entry.renderPromise` → return it. Else set
   `entry.renderPromise = Promise.resolve().then(() => _renderFileBodyNow(entry))`.
7. **`_renderFileBodyNow(entry)`** (sync): guard `if (entry.rendered) return entry.fileBody`.
   `unobserve` the body; **bail if `entry.gen !== this._renderGen`** (stale render). Save/restore
   the shared `_pendingHunkRecords` around a single `renderPatch` call (no `await` between — see
   Hazards); render binary row if `entry.binary`. Clear `minHeight`; set `rendered=true`,
   `renderPromise=null`. Call `_registerHunkAnchorsForFile(records)` and
   `validatePendingEofGaps(entry.fileBody)`.

### Phase B — Incremental hunk summaries (pr.js)
8. Split one-shot `_kickOffHunkSummaries` into:
   - **`_fetchHunkSummaryMap()`**: config gate + localStorage restore + fetch the hash→summary
     map once into `_summariesByHash`; apply to anchors that already exist; preserve `_renderGen`
     re-checks after each `await`.
   - **`_registerHunkAnchorsForFile(records)`**: stamp `data-hunk-start`, fill
     `_summaryAnchorsByHash` + `_summaryHashesByFile` (same body as pr.js:1127-1145), then apply
     any already-fetched summary from `_summariesByHash` and drain matching
     `_pendingSummariesByHash` via `_renderOneSummary`; re-enable per-file toggle.
9. **WS `review:hunk_summaries_ready`** (pr.js:2092): keep `_applyHunkSummaries`, but also merge
   the summaries into `_summariesByHash` so a file rendering *after* the event still picks them
   up. `_renderOneSummary`'s existing "anchor missing → queue in `_pendingSummariesByHash`"
   behavior (1313-1318) is the bridge; leave it unchanged.

   *(Note: backend skips summaries when files > `summaries.max_files` default 50, so this path is
   inert for the 303-file PR but must stay correct for small PRs.)*

### Phase C — Force-render at `<tr>`-scanning entry points (pr.js)
10. **`ensureLinesVisible`** (4222): `await ensureFileBodyRendered(file)` before the `tr` scan
    (covers comments + suggestions that funnel through it).
11. **`expandForSuggestion`** (4132): `await ensureFileBodyRendered(file)` after `findFileElement`.
12. **`scrollToFile`** (5904): make `async`; `await ensureFileBodyRendered(filePath)` before
    `scrollIntoView`. Audit callers (sidebar click 5843, keyboard jump).
13. **`toggleFileCollapse`** (3577) / **`toggleFileViewed`** (3603): make `async`; in the expand
    branch, `await ensureFileBodyRendered(filePath)` before removing `collapsed`.

### Phase D — suggestion-manager.js (bypasses ensureLinesVisible)
14. **`displayAISuggestions`** (~243): before `findHiddenSuggestions`/insertion scans, collect
    distinct `suggestion.file` values and `await prManager.ensureFileBodyRendered(file)` for each.
    Keep the existing `_isDisplayingSuggestions` guard; ensure new awaits are inside its `try` so
    it releases in `finally`. (Without this, an unrendered file has zero `tr`, so every line reads
    as "hidden gap" and gap-expansion runs against zero gap rows → silent anchor failure.)

### Phase E — Tests (Phase F: changeset + README)
15. Unit + E2E (see Test plan). Add `.changeset/*.md` (`minor` — user-facing perf improvement);
    update README if diff-render behavior is documented.

## IntersectionObserver lifecycle

- **Created** in `renderDiff` (one per render generation, stored on `_fileBodyObserver`).
- **Observes** each `.d2h-file-body` (NOT the wrapper — the body carries `display:none` when
  collapsed, so collapsed files never intersect). Registered in `renderFileDiff`.
- `rootMargin: '800px 0px'`, `threshold: 0`, `root` = the `.diff-view` scroll container if it's
  the scroller (verify in pr.css), else viewport.
- **On intersect** → render body, then `unobserve` (one-shot per file).
- **Disconnected + recreated** at the top of every `renderDiff` — covers initial load,
  whitespace toggle (both modes), scope change, and branch-review dialog (all funnel through
  `renderDiff`).
- Collapsing an already-rendered file leaves its body in the DOM (instant re-expand). Bodies are
  only discarded by a full `renderDiff` rebuild.

## Hazards

- **`renderPatch` mutates shared `_pendingHunkRecords`.** `_renderFileBodyNow` must keep the
  `save → renderPatch → restore` sequence **synchronous (no `await`)** so concurrent file renders
  cannot interleave records. Document this invariant.
- **Stale render races.** `renderDiff` replaces `_lazyFileBodies` wholesale and bumps
  `_renderGen`. An in-flight `renderPromise` from a prior render could write into the new summary
  maps → guard with the per-entry `gen` check in `_renderFileBodyNow`. `_fetchHunkSummaryMap`
  keeps `_renderGen` re-checks after each `await`.
- **Observer vs on-demand double render.** `entry.rendered` + shared `entry.renderPromise` +
  `unobserve`-on-render de-dupe; `_renderFileBodyNow` early-returns if already rendered.
- **`findHiddenSuggestions`/`ensureLinesVisible` treat "no `tr` found" as "collapsed gap."** With
  lazy bodies an unrendered file has zero rows, so force-render MUST precede these scans
  (Phases C & D).
- **Async signature changes.** `toggleFileCollapse`, `toggleFileViewed`, `scrollToFile` become
  `async`. Header callbacks (3121-3122) are fire-and-forget (fine); `expandForSuggestion`→
  `toggleGeneratedFile` (4145) and keyboard/sidebar callers must `await` or retain the existing
  `setTimeout(50)`.
- **`validatePendingEofGaps`** changes from one global call to per-file (`root` arg). EOF gap rows
  only exist in rendered bodies, so per-file scoping is correct; confirm pr.js:3055 is the only
  global caller.
- **Ctrl+F / browser-find regression.** Off-screen and collapsed bodies aren't in the DOM, so
  native find misses them (collapsed files are `display:none` today, so already unfindable;
  expanded-offscreen is the real delta). Acceptable for the large-PR case; document it. Optional
  future: "render all" toolbar action.
- **Scroll-jump.** Collapsed→expand renders synchronously before un-collapsing (no jump).
  Expanded-offscreen uses an estimated `min-height` placeholder; tune `APPROX_LINE_PX` and err
  slightly high. `handleWhitespaceToggle` already restores `scrollY` via rAF (pr.js:2257-2269).

## Both-mode parity checklist

- Core render (`renderDiff`/`renderFileDiff`/`renderPatch`) is in PRManager → shared. Verify in
  **both** modes: initial load, whitespace toggle (PR pr.js:2250 / Local local.js:473), and
  Local-only scope change (`_applyScopeResult` local.js:1560, `showBranchReviewDialog`) all
  recreate the observer and reset lazy state because they route through `renderDiff`.
- Local `_applyScopeResult` re-anchors via `loadUserComments` + `loadAISuggestions` (local.js:
  1598-1603) — confirm these still anchor after lazy bodies (they go through Phases C/D).

## Test plan

**Unit (vitest + jsdom; mirror `tests/unit/render-patch-hunk-hashes.test.js` /
`expand-for-suggestion.test.js`, instantiate via `Object.create(PRManager.prototype)`):**
new `tests/unit/lazy-file-body.test.js` covering — `renderFileDiff` produces 0 `tr` and does NOT
call `renderPatch`; collapsed gets no `min-height`, expanded-offscreen gets one;
`ensureFileBodyRendered` idempotency + shared promise + `null` on unknown file;
`_renderFileBodyNow` clears min-height & sets `rendered`; incremental hunk anchor applies a
pre-seeded `_summariesByHash`; stale-`gen` guard skips registration. Extend
`suggestion-manager.test.js` (force-render before anchoring) and `expand-for-suggestion.test.js`
(awaits `ensureFileBodyRendered`).

**E2E (playwright; mirror `pr-page.spec.js`, `hunk-summaries.spec.js`):** first update
`global-setup.js` fixtures to include a collapsed (viewed/generated) file and an offscreen file,
and fix `waitForDiffToRender` (it waits for `.d2h-code-line-ctn`, which won't appear if the first
file is collapsed/offscreen). New `tests/e2e/lazy-diff.spec.js` covering — collapsed body has 0
`tr` until expanded; expand renders + highlights; offscreen file renders on scroll; user comment
on an unrendered file forces render + anchors; AI suggestion on an unrendered file forces render +
anchors; whitespace toggle re-renders cleanly with no duplicate bodies (run in **both** PR and
local modes); hunk summary anchors on a small PR for both a visible and a scroll-rendered file;
sidebar jump-to-file renders + scrolls.

## Verification

1. `pnpm test` — unit + integration green; new lazy-render unit tests pass.
2. `pnpm run test:e2e` (via a Task per CLAUDE.md) — new lazy-diff specs pass in both modes.
3. Manual: open `shop/world#773906` in pair-review; confirm the page is interactive within ~1s,
   collapsed translation files show headers but no rendered rows (DevTools: `tbody` empty until
   expanded), expanding a file renders it, scrolling renders offscreen files, comments/suggestions
   still anchor. Spot-check a small PR for hunk summaries + Ctrl+F behavior.

---

## Deferred backend follow-up

The secondary, backend-side cost (the `/diff` endpoint re-parsing and re-hashing the multi-MB diff
on every request) is **deferred** and tracked separately in
[plans/diff-endpoint-perf.md](diff-endpoint-perf.md). Not part of this change.
