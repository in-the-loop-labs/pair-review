# CodeView virtualized diff: migration ledger

Migrate pair-review's diff rendering from one `@pierre/diffs` `FileDiff` per file to a single virtualized `CodeView`, on `@pierre/diffs` 1.6.4, with no functional regression in PR mode or Local mode.

This file is the record of the migration: the decisions, the vendor facts the design rests on and where each is tested, the gate results, the hazards, the parity matrix, and what each phase did. It is updated at the end of every phase. The full implementation plan (architecture, per-phase steps) is the session document `PLAN.md`; everything a later reader needs to check the work is repeated here.

Branch: `fable-code-view`. The previous attempt is the local branch `pierre-code-view`; it is read for reference and never merged or cherry-picked.

## 1. Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Dependency bump to `@pierre/diffs` 1.6.4, alone | Done (`de5d96e6`) |
| 1 | Test infrastructure, vendor contract suite, remaining gates | Done (this entry) |
| 2 | Characterization on the current engine: engine-neutral E2E helpers, Local-mode coverage, corpora, new specs N1–N12, golden dump, performance baseline | Not started |
| 3 | Data-first refactors on the current engine | Not started |
| 4 | The new bridge, in isolation, proven against the real vendor | Not started |
| 5 | Cut-over 1 behind the engine switch: the read-only diff | Not started |
| 6 | Cut-over 2: annotations and interaction | Not started |
| 7 | Cut-over 3: reveal, expansion, navigation | Not started |
| 8 | Flip and delete | Not started |
| 9 | Proof and evidence | Not started |

## 2. Approach

Hybrid, weighted to a fresh port: re-implement the CodeView integration on today's main, keep main's contracts, and transplant a fixed list of functions and test assets from the old branch. The reasons, in short: a cherry-pick of the old branch conflicts in 8 files with 23 semantic hunks and merges real bugs silently; the old bridge renders zero annotations on 1.6.4 without logging anything (a vendor callback signature changed) while its 181 fake-based unit tests stay green; and main has since moved four contracts the old bridge was built against.

The rule that follows from the second reason governs all testing here: **the real vendor in a real browser is the only arbiter of what the vendor does.** There is no hand-written model of `CodeView` in this repository.

### Test layers

| Layer | What | Command | Arbiter for |
| --- | --- | --- | --- |
| L0 | Console and page-error guard, stale-bundle test, entry-exports test, grep tests | part of `pnpm test` and `pnpm run test:e2e` | Boundary TypeErrors, a stale vendor bundle, forbidden patterns |
| L1 | Vendor contract suite: the real bundle, no app | `pnpm run test:contract` (`tests/contract/vendor`, `tests/contract/gates`) | Every vendor fact the bridge relies on; fails first on a bump |
| L2 | Bridge-in-browser: real bundle plus real bridge | `pnpm run test:contract` (`tests/contract/bridge`, from phase 4) | Bridge behaviour |
| L3 | App E2E, both modes | `pnpm run test:e2e` | User-visible behaviour |
| L4 | Golden render and landing dumps, FileDiff engine against CodeView | script, from phase 2 | Rendering parity |
| L5 | Live drive of the real server on a real repo | script, phase 9 | Real contents, untested surfaces |
| L6 | Performance comparison | script, phases 2 and 9 | No performance regression |

Rules for running them: never two Playwright E2E processes at once (they share ports 4000+workerIndex and one database); the contract suite binds no port and may run at any time; a failure set that changes between identical runs is flake, and the spec is re-run alone (`npx playwright test tests/e2e/<file> --workers=1`) before anything is concluded.

## 3. Decisions

Source tags in the copied tables below (`[P§n]`, `[P12]`, `[API§n]`, `[MAIN§x]`, `[DRIFT§n]`, `[OLD§x]`, `[TESTS§x]`, `[A§n]`, `[B§n]`, `[V]`) refer to the research reports and probe results of the planning session. They are kept so a claim can be traced; the in-repo evidence for a vendor claim is the contract suite (section 4).

| # | Decision | Why |
| --- | --- | --- |
| D1 | No non-CodeView renderer for **diff** files. A missing vendor bundle shows an error panel in the diff pane. | The bundle is built by `prepare` and shipped under `public/` (`package.json:10-21, 36` [V]). The old branch kept the legacy fallback and paid with 19 double-pathed branches and no E2E coverage [OLD§d4, A§1.2]. CLAUDE.md asks for no legacy stubs. |
| D2 | Context files render in a non-virtualized vendor footer region after the diff list, using main's existing legacy renderer unchanged. Sidebar order is unchanged. **Needs user sign-off (Q1).** | Every context-file feature keeps its exact code. Verified feasible [P12]. The alternative re-implements all of them in an area with no E2E coverage today. |
| D3 | The total highlight budget (900 KB / 18,000 lines) is removed. Per-file caps stay. | It protects a non-virtualized renderer. Under virtualization only mounted items highlight. Later files become highlighted instead of plain. |
| D4 | The "Large diff … Load diff" placeholder stays (parity). | A zero-hunk item plus a notice annotation; "Load" is an `updateItem` on the same id. |
| D5 | Content upgrade uses `hydratePartialDiff` for `change`/`rename-changed`. | Keeps git's hunks, 0 px shift; `parseDiffFromFile` shifts rows 60 px [P§6]. Main re-diffs today, so post-upgrade context rows next to hunks can differ from main by a line; classified as intended in the golden comparison (section 7.5). |
| D6 | `@pierre/diffs` pinned to exactly `1.6.4`. | The bridge reads three vendor internals (as main does) and avoids one vendor bug. The contract suite gates every bump. |
| D7 | Re-render (whitespace, refresh, scope) restores the first visible file's position. | Main tries to and fails (`window.scrollY` no-ops [MAIN§e5]). Exact restore is measured [P12]. |
| D8 | Line selection is viewer-wide (selecting in file B clears file A) [P§8]. | Main clears the selection after every use already [MAIN§a12]. |

### Questions that are the user's

- **Q1 (D2).** Context files (added by chat, tours, or the user) will appear after all changed files in the diff pane instead of interleaved by path. Sidebar order, chunks, gap expansion, comments, chat, collapse and dismiss are unchanged. The alternative keeps the position but re-implements context files as CodeView items (verified feasible with public API only [P12]): about 3–4 more sessions and a changed look (vendor highlighting and separators).
- **Q2.** Browser find-in-page (Cmd/Ctrl+F) will only see the 2–4 files mounted near the viewport [P§5]. On main a file stays in the DOM once it has rendered. This is inherent to `CodeView`; no vendor mitigation exists.
- **Q3 (permission, resolved in phase 0).** Phase 0 needs `pnpm exec playwright install chromium` for this worktree (about 300 MB). Another worktree's install deleted the build this worktree's Playwright 1.59.1 needs; only build 1254 is in `~/Library/Caches/ms-playwright` now [V]. The plan installs into a private `PLAYWRIGHT_BROWSERS_PATH` so it cannot happen again.

- **Q4 (found in phase 1).** The E2E suite runs with CSS transitions and animations on. Main's fixture carried an init script meant to switch them off; it has never styled a document (hazard H41). The dead script was deleted, which changes nothing about how any test runs. Whether to make the original intent real (transitions off, a suite about 10% faster, further from production) is a suite-wide timing change and is the user's call. The measurements are in section 11, phase 1.

Work proceeds on the defaults (D2 as written, transitions left on) unless the user answers otherwise. Phase 5 is the first phase that depends on Q1.

## 4. Vendor facts and where each is pinned

Every fact was measured on the real 1.6.4 bundle in headless Chromium before the plan was written, and is now an assertion in `tests/contract/vendor/`. "Bug", "constraint" and "quirk" in a test title mean the test pins behaviour the bridge must work around; if such a test fails after a vendor bump, the behaviour may be fixed, and the fact is re-read before application code changes.

| # | Fact | Consequence for the design | Contract spec |
| --- | --- | --- | --- |
| F1 | `setItems` / `removeItem` that shift a mounted item's index leave an orphan host or mis-accounted height, and it does not heal. | The item list is replaced, never spliced. | `list.spec.js` |
| F2 | `setItems([])` + `setItems(next)` + `render(true)` in one task leaves 0 orphans and an exact layout, for the same list, one item removed above, one inserted above. A line scroll target issued right after it puts the first visible line back at the same pixel, in the same task. | This is the re-render primitive. Public API only. **The restore is a line target, not item top plus a pixel offset (section 6, item 9).** | `list.spec.js` |
| F3 | `render(true)` after `updateItem` is a synchronous flush: card connected, `onPostRender` fired, heights updated in the same task. | An annotation-only publish on a mounted item keeps main's "the card is there when the call returns". | `annotations.spec.js` |
| F4 | `render(true)` from inside `renderAnnotation` or `renderCustomHeader` logs `rendered a different diff than its prepared layout` and leaves a height mismatch that does not heal. From `onPostRender`, or deferred to a microtask, it is clean. | The bridge never flushes inside a vendor render callback. | `flush.spec.js` |
| F5 | With the worker pool, replacing an item's `fileDiff` does not change the DOM in that task; the old diff stays displayed until the worker returns (about 1 s for a 300,000-character file). Without the pool it is synchronous. | Reveal and upgrade are asynchronous in the DOM, as on main. Data-level answers must not depend on the DOM. | `swap.spec.js` |
| F6 | While such a swap is pending, an annotation-only publish plus `render(true)` does not create or attach the card; it appears with the swap. | No consumer may read "card not in DOM" as "line not rendered". Card lookups go through the bridge's element cache. | `swap.spec.js` |
| F7 | Derived metadata published with the same `cacheKey` is never displayed. `PierreContext.mergeContextRanges` copies the key. `hydratePartialDiff` assigns its own (`<key>:hydrated`). | Every derived metadata gets a new key (`_rekey`). | `swap.spec.js` |
| F8 | Without a `cacheKey` a remount shows plain text first; with `parsePatchFiles(patch, { cacheKeyPrefix })` it shows highlighted rows at once. | Keys are used, with F7's discipline. | `swap.spec.js` |
| F9 | A static `itemMetrics` gives an exact layout. Growth inside the header slot is never absorbed. The extent follows growth inside annotations within frames, also at maximum scroll. | Fixed-height header; no `setItemMetrics` loop; nothing that grows goes in the header. **Corrected by G9: two metrics are needed in this app, `diffHeaderHeight` and `lineHeight` (section 6).** | `layout.spec.js`, `gates/g09-*.spec.js` |
| F10 | A `lineNumber: 0` annotation is measured and tracks growth. An always-present empty one costs 0 px on ordinary and row-less items, given one CSS fix for row-less items. | The file-comment zone is an always-present first annotation. **The CSS fix is corrected (section 6).** | `layout.spec.js`, `gates/g11-*.spec.js` |
| F11 | Item and line scroll targets land with 0 px error, including never-mounted items. `scrollTo({ type: 'position' })` lands short (4960 for 5000). A line target set while that line's swap is pending is not retried. | No sticky compensation. Position writes use `root.scrollTop`. Reveal waits for the line to be displayed before the final scroll. | `scroll.spec.js` |
| F12 | After `updateItem` on the hovered item, `data-hovered` and the gutter utility disappear until the pointer moves; a synthetic `pointermove` restores both. With `pointerEventsOnScroll: true` hover goes stale after a scroll. | Port main's hover restore; hide the gutter on scroll. | `interaction.spec.js` |
| F13 | With the default `pointerEventsOnScroll: false`, item content takes no pointer input right after a scroll, including buttons inside annotations. | `pointerEventsOnScroll: true`. | `interaction.spec.js` |
| F14 | The `renderCodeViewFooter` region is rendered once, after the last item, inside the scroller; it survives `setItems([])`; sticky and `scrollIntoView` work inside it; clicks right after a scroll work. Growth above the viewport inside it moves visible content by the growth (`overflow-anchor: none` on the root). | Context files can live there (D2). The app anchors its own mutations of the region. | `footer.spec.js` |
| F15 | `hydratePartialDiff` works for `change` and `rename-changed`; it throws for `new`, `deleted`, and zero-hunk `change` diffs; a pure rename stays header-only. | The upgrade strategy is per diff type. | `hydration.spec.js` |
| F16 | `renderAnnotation(annotation, fileOrDiff, context)`; `onPostRender(node, instance, phase, context)`; hosts are pooled and keep attributes; every update of an item replaces all its rows; per-instance `setOptions` / `setThemeType` throw. | Signatures from the contract suite; stamps reconciled on mount and update and stripped on unmount; row decorations re-applied from `onPostRender`. | `annotations.spec.js` |
| F17 | `expandHunk` on a partial diff throws without `loadDiffFiles`; `onHunkExpand` is not forwarded; the expansion map survives a `fileDiff` replacement keyed by hunk index. | Never call `expandHunk` on a partial diff; clear the map before publishing metadata with different hunks. | `hydration.spec.js` |
| F18 | The pool keeps highlighting off the main thread (268 animation frames with plain rows on screen against 1, for a 20,000-line added file); a worker script that fails to load falls back on the same instance. | Pool kept; main's fallback machinery is not ported. | `worker.spec.js` |
| F19 | A zero-change base from `parseDiffFromFile(file, file)` plus `mergeContextRanges` renders range chunks with expand controls. | The costed alternative to D2 works without private API. | `hydration.spec.js` |

Also pinned, because the design leans on them: the annotation identity rules (which changes re-invoke `renderAnnotation`; a focused textarea keeps node, value and focus when another annotation is appended), a cached annotation element re-attached intact after eviction, an annotation on an unrendered line being attached with zero height and no error, `updateItem` with an unchanged version doing nothing, viewer-wide line selection (D8), `setOptions` as a replacement that keeps the first visible line and focus, `layout.gap`, collapse above the viewport moving nothing, the `collapsedContextThreshold` rule the visibility oracle copies (a gap of 5 lines or fewer is painted in full), and the shadow-DOM row model (`internals.spec.js`, `annotations.spec.js`, `options.spec.js`, `interaction.spec.js`).

## 5. Gate results

Gates G1–G6 of the candidate plans were run while the plan was written and are facts F14, F4, F7, F10, F12 and F15 above. G7–G12 were run in phase 1. Measurements are in `gates/*.json` of the phase-1 evidence directory and are re-recorded by `CONTRACT_EVIDENCE_DIR=<dir> pnpm run test:contract`.

| Gate | Question | Result | Consequence |
| --- | --- | --- | --- |
| G7 | A worker that never responds: does `workerInitializationTimeout` fall back? | **Yes.** After the timeout the same `CodeView` renders and highlights on the main thread; `pool.getStats().workersFailed` is `true`. The vendor logs exactly one `console.error`, `WorkerPoolManager: worker initialization timed out after Nms`. Nothing is mounted while the pool is still initializing. | No bridge-side timeout. The value passed (15000 planned) is how long a user with a broken worker sees an empty diff pane; an E2E test that breaks the worker on purpose must expect that one error. |
| G8 | `pointerEventsOnScroll: true`: scroll frame times on the full workload | **No measurable cost.** 240 real wheel steps of 120 px, pointer parked on the code, shipped bundle, pool on: frame p50 / p90 / p99 / max = 10.5 / 16.7 / 27.2 / 27.3 ms with `false`, 10.3 / 16.7 / 27.2 / 27.2 ms with `true`; no frame over 33 ms in either. | `pointerEventsOnScroll: true`, as planned. No click-retry rule. |
| G9 | The app's real header (every variant), `ANNOTATION_CSS`, `pr.css` card and zone rules, the host without the 24 px margin and with `layout.gap: 24`: validator 0? | **Validator 0 and an exact audit in all four combinations (light, dark) x (unified, split), over 63 audited screens each including a walk with a tour active, once three things the plan did not have were added** (section 6, items 1 to 3). Main's header is 45 px in every variant (plain, renamed, generated, viewed, comment indicator, summary toggle, long path). | Required metrics, layout and CSS are listed in section 6. |
| G10 | Collapse on a swap-pending item, theme change during a pending swap, a second replacement before the first lands | **None of them interleaves.** Collapse takes effect in the same task (item height = header) and the layout stays exact; the new diff is displayed after the next expand. A theme change during a pending swap ends with the new diff displayed in the new theme. With two replacements issued in one task the intermediate one is never displayed: the observed order is `base` then the last published metadata. | The bridge does not need to serialise `fileDiff` replacements per item. |
| G11 | A `notice` annotation and a zone annotation both at `lineNumber: 0`: order and heights | **Array order is visual order; heights are exact** on row-less, ordinary and deleted items, unified and split. An empty zone is 0 px; filling it moves the notice down by exactly the content. In split style this needs the corrected row-less CSS (section 6, item 4). | The notice stays a separate annotation after the zone. No merge into the zone element. |
| G12 | Reveal latency on the current engine, 300,000-character file | **Baseline: median 1008 ms** from `PierreBridge.addContextRanges` to the revealed row being painted (5 reveals: 999, 966, 1093, 1026, 1008 ms), through main's bridge and `FileDiff` with the worker pool. The same reveal as a raw `CodeView` item update: median 1014 ms (1014, 1044, 995, 1051, 1001). Both were measured in the same run, four contract workers in parallel. | Phase 7's bar is this median plus 20%, re-measured in the same run as the new bridge. The reveal is asynchronous on main too: the data-level answer (`isLineVisible`) is immediate, the DOM lags by a worker round trip. |

## 6. Corrections to the plan found in phase 1

Each of these is proven by a contract test, changes a later phase's design, and supersedes the plan text it names.

1. **`itemMetrics.lineHeight` must be passed, and measured.** (Plan fact F9 and section 4.1: "row 20 px equals the vendor default".) `pr.css` sets `--diffs-font-size: 12px` and `--diffs-line-height: 1.45` on every `diffs-container`; custom properties cross the shadow boundary, so the app's rows are 17.390625 px, not 20. With the vendor's default estimate the validator reports mismatches and items drift from where the vendor thinks they are (`g09` "why lineHeight is passed"). The value has to be measured from a probe row, not multiplied out: 12 x 1.45 is 17.4, the browser lays the row out at 17.390625 (layout units are 1/64 px), and the validator compares with strict equality. The bridge passes `itemMetrics: { diffHeaderHeight: 45, lineHeight: <measured> }`. The measured value depends on zoom; see hazard H38.
2. **The scroll root may have no vertical padding or border.** (Plan section 3.2.) The vendor lays items out from the top of the root's content box and does not account for anything above it. Main's `.main-layout .diff-container { padding: 16px }` and `.diff-container { border: 1px }` put every item 17 px below where the vendor computes it. The vertical space moves into `layout: { paddingTop: 16, paddingBottom: 16, gap: 24 }`; horizontal padding on the root is harmless.
3. **Candidate CSS for the cut-over**, scoped by `.diff-view.codeview-engine` as phase 5 will scope it (source: `CANDIDATE_CSS` in `tests/contract/gates/g09-app-css-and-header.spec.js`):

   ```css
   .main-layout .diff-view.codeview-engine { overflow: hidden; }
   .diff-view.codeview-engine > #diff-container {
     flex: 1 1 0; min-height: 0; overflow-y: auto;
     padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0;
   }
   .diff-view.codeview-engine diffs-container.d2h-file-wrapper[data-file-name] { margin-bottom: 0; }
   .diff-view.codeview-engine .pr-file-header-slot { height: var(--pr-file-header-height); box-sizing: border-box; overflow: hidden; }
   .diff-view.codeview-engine .pr-file-header-slot > .d2h-file-header { position: static; height: 100%; box-sizing: border-box; }
   ```

   with `--pr-file-header-height: 45px`. No header variant overflows the fixed height.
4. **The row-less CSS fix is two rules, scoped by an annotation.** (Plan fact F10 and section 3.7: `[data-code]:not(:has([data-line])) { padding-bottom: 0 !important; }`.) That rule is wrong twice. In split style the 8 px is on `pre[data-diff]`, not on `[data-code]`, so the rule does nothing there. And it also matches an ordinary item that is mounted with no rows in its rendered window, where the vendor does count the 8 px, so it breaks those mounts. The correct `unsafeCSS` is `ROWLESS_FIX` in `tests/contract/harness/constants.js`:

   ```css
   [data-code]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }
   pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }
   ```

   Phase 4 moves the constant into `pierre-styles.js`; the contract specs then import it from there.
5. **`instance.getLineIndex(line, side) != null` is not a "line is displayed" test.** (Plan section 3.10, `whenLineDisplayed`.) `getLineIndex` extrapolates an index for a line hidden in a collapsed gap, so it is never null there. The signal that works is `instance.getRenderedDiff() === <the metadata the bridge last published>`: while a swap is pending the item and `instance.fileDiff` already hold the new metadata and `getRenderedDiff()` still returns the old one. Once they match, the bridge's own metadata oracle describes the screen. `instance.isLineRenderable(line)` follows the rendered diff but answers `true` for a hidden line of a partial diff, so it cannot be used alone (`internals.spec.js`).
6. **F1 is timing-dependent for `removeItem`.** The height mis-accounting appeared when `removeItem` ran inside an animation-frame callback and not when the same call ran from a separate task, on this workload. The orphan host after an inserting `setItems` appeared either way. The design is unchanged (no splicing at all), and the finding says a "works when I tried it" result for `removeItem` proves nothing.
7. **The gutter utility needs its own stacking.** The vendor's slot wrapper is absolutely positioned inside the hovered gutter cell and, without a `z-index` on the slotted element, the cell's line-number content is on top of it and takes the click (which then starts a line selection). Main's `.pierre-gutter-buttons` rule already has `position: absolute; z-index: 20; pointer-events: auto`; it must survive the port.
8. **In unified style an all-added or all-deleted file's lone column is `code[data-unified]`.** `code[data-additions]` / `code[data-deletions]` exist only in split style. Anything that derives a side from the column element must take the diff style into account.

9. **Re-render restores the view with a line scroll target, not with `root.scrollTop = getTopForItem(id) + delta`.** (Plan fact F2, section 3.4, decision D7.) `setItems([])` drops every measured height. Right after the following `render(true)` the anchor item can be mounted only partially, with a wrapped line above the viewport still estimated at one row; when that line is measured a frame later the vendor keeps the visible line in place, so the pixel offset recorded before no longer means the same thing and the view ends up a wrapped line away (20 px in the contract case, deterministic). The planning probe saw 0 px because its anchor item happened to be fully measured. The primitive that is exact in every case tried (near the top of an item, deep inside a 3,000-line item; same list, one removed above, one inserted above): record the first row below the sticky header as `{ id, lineNumber, side, top }`, then after clear-then-set call `codeView.scrollTo({ type: 'line', id, lineNumber, side, align: 'start', offset: top - headerHeight })` and `render(true)`. When no row is visible (collapsed or row-less first item) an item target with an offset does the same job (F11).

## 7. Architecture in brief

- `PierreBridge` (new) owns the one `CodeView`, the worker pool, the item records, annotation arrays and the element cache, publish and flush, all vendor shadow-DOM knowledge, host stamping, scroll primitives and metadata derivation. It never reads `PRManager` state; it receives hooks (`renderHeader`, `hostState`, `onItemLifecycle`, `renderFooter`).
- `PRManager` owns domain state, the entry list, header DOM, file-comment zones, the content-fetch queue, navigation policy and the context-file region. It never touches `shadowRoot` or `window.PierreDiffs`.
- `#diff-container` is the CodeView root and the scroll container; the toolbar and tour bar are non-scrolling siblings above it; a sibling `#diff-status` shows loading, error and empty messages. Nothing writes `innerHTML` on the root.
- One `type: 'diff'` item per changed file, id = the decoded new path. Files without a renderable patch are still items (header-only), with a `notice` annotation where main shows a message. The list is replaced on re-render and the first visible line restored with a line target (F2, correction 9), never spliced (F1).
- The file-comment zone is a `lineNumber: 0` annotation, first in every item's array (F10). Context files render with main's legacy renderer in the footer region (D2, F14).
- Annotation data is written first; cards are built once and synced on every `renderAnnotation` call; card lookups go through `getAnnotationElement`, which can build a card that is not mounted (F6).
- Visibility is decided from the bridge's own metadata plus the instance's expansion map, never from the DOM (F5). Reveal is `ensureLinesVisible`, `scrollToLine`, wait until displayed (correction 5), then main's `scrollIntoViewStable`.
- During phases 5 to 7 the new engine sits behind `window.__PAIR_REVIEW_DIFF_ENGINE === 'codeview'`, set by the E2E fixture when `PR_ENGINE=codeview`, read once in the `PRManager` constructor. Phase 8 deletes the switch.

## 8. Hazards

**Existing code paths that do similar work**

- H1. Five "re-render then re-anchor" sequences: PR `handleWhitespaceToggle` → `_rerenderAllOverlays` (`pr.js:2843-2863`); `refreshPR`; Local whitespace (`local.js:530-547`); Local `_applyRefreshedDiff` (`local.js:943-947`); Local `_applyScopeResult` (`local.js:1691-1693`). A sixth, the Local base-branch change (`local.js:593-600`), re-renders without re-anchoring [MAIN§e5]. All reach `renderDiff`. Phase 3 routes the Local copies through the shared helper; the base-branch path is characterized, not changed.
- H2. "Render a file body, register hunk anchors, enqueue the upgrade" exists twice (`_renderPierreFileBodyNow`, `_renderDeferredDiff`); the deferred copy skips the upgrade. Both collapse into `_buildDiffEntry` plus the mount hook; keep the difference.
- H3. Two "reveal lines" implementations, `ensureLinesVisible` and `expandForSuggestion`, with different padding and collapse semantics [MAIN§e8]. After the port `expandForSuggestion` serves context files only.
- H4. Comment-card markup exists in the bridge renderer and in `CommentManager.displayUserComment`; header-button markup exists three times [MAIN§e8]. Posted-comment stamping must be applied in every copy that stays routed.
- H5. `local.js` patches `PRManager` methods. Any method renamed or split in `pr.js` must be checked against the patches in `local.js`.
- H6. During phases 5–7 two bridges exist. Shared renderers live in `pierre-annotations.js` so they cannot drift; the switch-site test bounds the branching.

**Shared functions that change, and all their callers**

- H7. `renderDiff`: `loadAndDisplayFiles` (PR initial, whitespace, `refreshPR`), `loadLocalDiff` (Local initial, whitespace, refresh, scope, base). Every caller gets clear-then-set and anchor restore; tour exit stays before teardown.
- H8. `ensureFileBodyRendered` (deleted): `toggleFileCollapse:5154`, `toggleFileViewed:5201`, `expandForSuggestion:5828`, `ensureLinesVisible:5968`, `scrollToFile:8114`, `scroll-into-view.js:125`, `AIPanel.scrollToFinding:1426`, `scrollToComment:1529`, `scrollToExternalThread:1626`, `SuggestionNavigator.ensureSuggestionVisible:285`, `SuggestionManager.displayAISuggestions:334`. Each call site is replaced, not just removed: several used its return value as "the body element".
- H9. `ensureLinesVisible`: `review:expand_hunk` handler (`pr.js:2679`), `_fetchUserCommentsForRender:6689`, `_renderAdoptedUserComment:6900`, `SuggestionManager.displayAISuggestions:352`, `ExternalCommentManager:457` and `:624`, `AIPanel.scrollToFinding:1433`, `scrollToComment:1536`, `ChatPanel._scrollToLine:5960/5983`, `TourRenderer.prepareStop:251`. Contract kept: `isLineVisible` is true when it resolves. New: the DOM may lag by a worker round-trip (F5), and files may be unmounted.
- H10. `toggleFileCollapse`: header chevron and click, `toggleGeneratedFile`, `AIPanel.expandFileIfCollapsed`, `SuggestionNavigator.ensureSuggestionVisible`, `TourRenderer._mountStopPierre` and its unmount restore. The header callers have a mounted file; the others may not.
- H11. `loadUserComments`: init in both modes, `_rerenderAllOverlays`, Local whitespace/refresh/scope, `_handleCommentFormSubmit`, `restoreUserComment`, `clearAllUserComments`, `loadContextFiles`, the deferred re-anchor, the `commentFilterChanged` listener. Its clear-and-add block must stay synchronous inside one `bridge.batch`; the generation and version retry guard (`pr.js:6548-6576`) must be preserved; no `await` may be added inside the block.
- H12. `pierreBridge.files.has/get` (`pr.js:1531, 1862, 3788, 4252, 5168, 5192, 5209, 5859, 5971, 6063, 6592, 6897, 7046`; `suggestion-manager.js:380, 473`; `external-comment-manager.js:531`; `tour-renderer.js:566`; `ChatPanel.js:5955, 5986`; `comment-manager.js:321` [MAIN§b]): meaning changes from "rendered" to "is a diff item". `files.get(f).container` (2 sites) and `.instance` (E2E only) go away.
- H13. `findFileElement`: returns `null` for an unmounted file (phase 3 audit).
- H14. `bridge.addAnnotation` (`pr.js:6065, 6906, 7073`; `hunk-summary-renderer.js:179`; `external-comment-manager.js:637`; `tour-renderer.js:421`) and `addAnnotations` (`pr.js:6615`; `suggestion-manager.js:402`); `removeAnnotation`, `removeAnnotationsByType`, `getAnnotations` [MAIN§b]. `applyServerComment` (`pr.js:7537`) mutates `metadata.data` in place and relies on the stored reference; that stays valid and `sync` picks it up.
- H15. `FileCommentManager.loadFileComments(comments, suggestions)` (null leaves alone, array replaces): `_loadUserComments`, `_removeRenderedSuggestions`, suggestion display. All must reach unmounted zones through the registry.
- H16. `_materializeDeferredDiff`: the Load button, `expandForSuggestion`, `ensureLinesVisible`.
- H17. `ScrollUtils.scrollIntoViewStable`: file scroll, the three AIPanel paths, the navigator, context-file scroll. It must never be handed a wrapper for an unmounted file.
- H18. `_renderAnnotation` and the element cache: the vendor callback, `getAnnotationElement`, every `find*Card`. One code path builds; `sync` runs on every return.

**State that can change between scheduling and execution**

- H19. Virtualization unmount between any `await` and the DOM use after it. Rule: after an `await`, re-resolve through `getAnnotationElement` or `findFileElement`; never hold a host or row across an `await`.
- H20. `renderAll` during an in-flight content fetch, hunk-summary fetch, suggestion display or navigation. `_renderGen`, the abort controller, `_displayEpoch`, `_navGen`, `_tourGen` guard these; `_publish` adds the re-`getItem` check; the `when*` waits take a cancel predicate.
- H21. A diff swap pending on an item (F5): annotation publishes are held (F6); a scroll target set now lands on a separator (F11); a second replacement can be issued before the first lands (G10); the user can collapse the file meanwhile.
- H22. A background upgrade landing while the user types in that file, hovers it, or is mid-smooth-scroll to a line in it. Pointer gate, new focus gate (3.14).
- H23. The pool not ready during the first 40 ms or so: nothing is mounted and a flush does nothing [P12]. No consumer may read "card not in DOM" as "line not renderable".
- H24. Filter flips, publication refreshes and suggestion status changes while a card is detached or not yet built. Covered by data-first writes plus `sync`.
- H25. A pending vendor scroll target is cancelled by any `keydown`, `wheel`, `pointerdown` or `touchstart` on the root, including keys typed in a comment form [API§3.15]. Navigation must tolerate "never arrived".
- H26. Width changes when panels dock or float (#597) change wrapped-line heights. The vendor observes the root [API§3.16]; `slim-screen-panels` and `panel-resize` run under the switch in phase 5.
- H27. A context wrapper inserted or removed above the one in view (F14). `_mutateContextRegion`.
- H28. A reused `cacheKey` on derived metadata (F7): silent non-render. One `_rekey` function, a unit test, an L2 test.

**Completion and error handlers that assume they are alone**

- H29. `_handleCommentFormSubmit` removes the form, reloads comments and expands the new card for the minimizer; a concurrent `loadUserComments` from a WebSocket event can overtake it, and a suggestion display can publish the same item. The card lookup goes through `findCommentCard` after the reload settles.
- H30. `refreshPR`'s `finally` and the Local refresh handlers restore UI state assuming the diff they started with is current. They go through `_setDiffStatus`, which is idempotent, and never touch the scroller.
- H31. The tour's exit path restores collapsed files and removes context files it added; `renderDiff` tears the tour down first. With `setFileCollapsed` these no longer need a mounted wrapper, but the order (exit tour, then `renderAll`) must be kept.
- H32. `displayAISuggestions`' queue and epoch (#599) assume one display in flight. `_removeRenderedSuggestions` iterates `bridge.files`, which now holds every file; wrap it in `bridge.batch`.
- H33. The upgrade queue's drain assumes the item it fetched for still exists with the same metadata; compare `_renderGen` and the record's derivation counter before publishing.
- H34. The comment-minimizer's MutationObserver on `#diff-container` re-injects indicators on any subtree change. Virtualization produces many more mutations. Keep it for correctness; measure it in phase 9 and move it onto the lifecycle hook if it shows in the scroll profile.
- H35. Vendor callbacks run inside a render pass. Anything they call that publishes must not flush (F4); the depth counter enforces it.

**Vendor internals the bridge reads** (the same exposure as main [MAIN§e9], each pinned by an L1 test): `instance.hunksRenderer.expandedHunks` and `getExpandedHunk`, `instance.getLineIndex`, shadow attributes `data-line-index`, `data-column-number`, `data-line-type`, `data-line-annotation`, `[data-code]`, the slot name format, and the `FileDiffMetadata` shape used by `pierre-context.js`. No TypeScript-private CodeView method is called.

**Found in phase 1**

- H36. The shared E2E fixture diff (`tests/e2e/test-server.js`) is not a well-formed unified diff: the first hunk of `src/utils.js` declares 5/8 lines and holds 4/7, the `src/main.js` hunk declares 6/10 and the parser accepts 4/9, and blank context lines lack their leading space. The vendor parser logs this on every page load and renders what it parsed. About 100 specs index rows of this fixture by position. Before phase 5 depends on it, phase 2 must establish what `hydratePartialDiff` does with this patch against truthful contents (it may throw), and decide between fixing the fixture and keeping it as a deliberate "malformed patch" case.
- H37. The E2E file-contents mock answers every unregistered path with a generic 40-line body. Besides the geometry churn the conventions already describe, it makes the vendor log `DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong` when a highlight result for the patch-derived diff meets the re-diffed contents (seen on `q.sql` in `diff-header-lookalike-stats.spec.js`, Local mode). The message is allow-listed with that reason; phase 2's per-path registry of truthful contents should remove the cause, and the allowance with it.
- H38. `itemMetrics.lineHeight` is a measured sub-pixel value (17.390625 px at 100% zoom). Browser zoom and display scale change it. The bridge must measure it at construction, and a zoom change after that leaves the estimate for unmounted rows slightly off until they mount (mounted rows are measured). Phase 5 decides whether to re-measure on `resize`; the development-bundle E2E pass shows whether it matters.
- H39. Anything positioned by the app above the items inside the scroll root (padding, a border, a banner) shifts every item relative to the vendor's layout by its height (correction 2). The `#diff-status` sibling and the toolbar must stay outside the root.
- H40. Main logs about 5,500 `console.error` lines over one E2E run, all from a handful of causes (the table in section 11, phase 1). The console guard is only as good as its allow-list: an entry that is too wide switches the guard off for a class of errors. Entries carry reasons, "Failed to load resource" entries must name the request, and `tests/unit/e2e-console-guard.test.js` enforces both.
- H41. **E2E runs with CSS transitions and animations ON**, the same as production and the same as every E2E result main has ever produced. Main's `tests/e2e/fixtures.js` registered an init script to disable them ("for faster test execution"); an init script runs while `document.head` and `document.documentElement` are both null, on every navigation, so it threw a TypeError once per document and styled nothing (measured over a full run: 714 documents, 0 styled; a probe element with `transition: opacity 3s` computes `3s` in PR mode, after a reload, and in Local mode). Phase 1 deleted the script. Consequences for later phases: (1) a geometry or landing spec must wait for the settled value, never read once after a class change. The AI panel's `width` transition (`pr.css`, `.ai-panel`, 0.2 s) resizes the diff, re-wraps lines and so changes item heights while it runs (H26); popovers, badges and the add-comment button fade and move over 0.1 to 0.15 s; the line highlight keeps its class until `animationend` (3.5 s; `pierre-bridge.js:1266`, `pr.js:9516`, `ChatPanel.js:5745, 6029`). (2) The golden dump and the performance comparison (phases 2 and 9) are taken with transitions on for both engines. (3) Nobody may switch transitions off in the fixture as a side effect of another change: with a working injection the whole suite's timing changes (measured in section 11, phase 1), and that needs its own baseline. Smooth scrolling (`behavior: 'smooth'`) is not a CSS transition and is unaffected by such a style either way.
- H42. A Playwright init script cannot touch the DOM (same cause as H41: no `<html>` yet). The `PR_ENGINE` init script only sets a global, and it is registered on the browser **context**, so a second tab or popup opened by a spec gets the flag too. Registered on the `page` fixture, a page from `context.newPage()` would have run the default engine inside a `PR_ENGINE=codeview` run without any sign (measured before the change: flag `null` on the second page). No spec opens a second page today.

## 9. Parity matrix

How parity with main is proven for every item of the regression checklist, in both modes. A cell names the tests that cover the behaviour; phase 9 does not close while a cell lacks a passing test. Specs named `N1`–`N13` are written in phase 2 (N13 in phase 5); "+L" and "+PR" mean an existing spec is parameterized to the other mode in phase 2. Nothing in this matrix is changed by phase 1.

1. **Same spec, two engines.** Specs touch the diff only through `diff-dom.js`, so each scenario runs unchanged on FileDiff (phase 2) and CodeView (phases 5–9). A scenario that cannot exist on FileDiff (eviction) asserts the user-visible outcome of "scroll far away and back".
2. **The matrix below.** A cell may not rest on a stubbed unit test alone. Phase 9 does not close while a cell lacks a passing test.
3. **Golden comparison.** Pre-upgrade dumps must be identical between engines. Post-upgrade dumps must have identical changed rows; context rows may differ only where D5 applies (main's re-diff adds context next to a hunk), and each such file is listed. Position of context files is D2. Anything else is a regression.
4. **Known non-parities are recorded, not hidden:** D1–D8, Q2, the pre-existing Local gaps (`renamed`/`binary` never set by `local.js` [OLD§c7]), the Local base-branch change not re-anchoring on main.

Codes: plain name = existing spec; `+L` = parameterized to Local in phase 2; `+PR` = parameterized to PR; N*n* = new spec; `G` = golden; `C1`/`C2` = contract suite L1/L2; `U` = unit test (supporting only); `M` = live drive; `X(Dn)` = intentional change. "—" = the feature does not exist in that mode.

| # | Behaviour [MAIN§d] | PR mode | Local mode |
| --- | --- | --- | --- |
| 1 | Diff renders, sorted, numbers, styling, separators | pr-page Diff Display, N1, G | N1, G |
| 2 | Persisted diff style, no double render | split-view "persists split across reload" | same |
| 3 | Lazy rendering → virtualization | lazy-diff (rewritten: collapsed file has no rows; far file mounts on scroll), C1 | lazy-diff +L, C1 |
| 4 | Scrollbar stability, first-try landing | N4, G landings | N4, G landings |
| 5 | Large-diff placeholder and Load | lazy-diff | lazy-diff +L |
| 6 | Feedback on a deferred diff materializes it | lazy-diff | lazy-diff +L |
| 7 | Highlight budgets | N1 (per-file cap), U; total: X(D3) | N1, U; X(D3) |
| 8 | Worker pool, fallback | N2, C1 | N2, C1 |
| 9 | Wrap | N1, G | N1, G |
| 10 | Sticky header, nav offsets | comment-minimize nav test, smart-truncate, N4 | smart-truncate, N4, comment-minimize +L |
| 11 | Split view | split-view | split-view (core) + remaining tests +L |
| 12 | Split toggle keeps position; dropdown rollback | N4, U `pr-manager-diff-view` | N4 |
| 13 | Control hidden without bundle | X(D1): N13 | X(D1): N13 |
| 14 | Theme switch | N2 | N2 |
| 15 | Prose width cap | split-view "caps comment prose width" | split-view +L |
| 16 | Binary files | N1, G | N1, G |
| 17 | Renamed files | quoted-git-paths, N1, G | quoted-git-paths, N1, G |
| 18 | Added/deleted, one-sided split | split-view one-sided, N11 (zone side) | split-view +L, N11 |
| 19 | Mode-only, empty added | N1, G | N1, G |
| 20 | Quoted git paths | quoted-git-paths | quoted-git-paths |
| 21 | Header-lookalike lines | diff-header-lookalike-stats +PR | diff-header-lookalike-stats |
| 22 | Smart truncation | smart-truncate | smart-truncate |
| 23 | Generated files collapsed | N1 | N1 |
| 24 | Empty diff | N1 | N1 |
| 25 | Collapse/expand | lazy-diff, N3, N11 | lazy-diff +L, N3, N11 |
| 26 | Viewed | N3 | N3 |
| 27 | Navigator click | pr-page, N3, N4 | N3, N4 |
| 28 | No scroll-spy | N3 | N3 |
| 29 | Context files | N5; position X(D2) | N5; position X(D2) |
| 30 | Context-file line comments | N5 | N5 |
| 31 | Hunk expand | pr-page expansion, M | pr-page expansion +L, M |
| 32 | No controls until upgrade; limits; pointer idle | N12, U | N12, U |
| 33 | Patch parity | C2 upgrade test, G post-upgrade | C2, G post-upgrade |
| 34 | Programmatic reveal | inline-feedback-context, N11 | inline-feedback-context, N11 |
| 35 | Manual expansions survive | inline-feedback-context | inline-feedback-context |
| 36 | Preceding gap; range across hunk and hidden end | inline-feedback-context | inline-feedback-context |
| 37 | Off-hunk comments survive suggestion refresh | inline-feedback-context | inline-feedback-context |
| 38 | Expansion re-syncs split stretch | N12 | N12 |
| 39 | Legacy gap expansion (context files) | N5, U | N5, U |
| 40 | Gutter hover | comment-crud, pr-page, chat-lines, gutter-buttons | gutter-buttons, comment-crud +L |
| 41 | Gutter clears on leave, scroll, toggle | gutter-buttons (rewritten) | gutter-buttons |
| 42 | Hover survives re-render | N12, C1 | N12, C1 |
| 43 | Single-line comment form | comment-crud Creation | comment-crud +L |
| 44 | Multi-line range | comment-crud Multi-line (real drag), N6 | comment-crud +L, N6 |
| 45 | LEFT and context comments; side, position | split-view deletions column, U | split-view, U |
| 46 | Save flow | comment-crud | comment-crud +L |
| 47 | Cancel/Escape | N6 | N6 |
| 48 | Several forms keep text | N6 | N6 |
| 49 | Insert suggestion block | N6, U | N6, U |
| 50 | Comment card content | comment-crud-advanced Display, edited-posted-comments, markdown-rendering | comment-crud-advanced +L |
| 51 | Edit | comment-crud Editing, N11 | comment-crud +L, N11 |
| 52 | Delete | comment-crud Deletion, comment-crud-advanced, N11 | +L, N11 |
| 53 | Restore | comment-crud-advanced Restore, N11 | +L, N11 |
| 54 | Clear all | comment-crud-advanced, N11 | +L, N11 |
| 55 | Persist across reload | comment-crud Persistence, inline-feedback-context | comment-crud +L, inline-feedback-context |
| 56 | Concurrent load safety | N11 (save during reload), U | N11, U |
| 57 | Posted filter | comment-filter-menu, comment-publication, N11 | comment-filter-menu, N11 |
| 58 | Chat about a comment | chat-lines | chat-lines +L |
| 59 | Counts | comment-crud-advanced, N11 | +L, N11 |
| 60 | Suggestions render | ai-analysis-actions, split-view "AI suggestion in additions column" | ai-analysis-actions +L, split-view |
| 61 | Re-display replaces | ai-analysis-sidebar, N11, U | ai-analysis-sidebar +L, N11 |
| 62 | Adopt | ai-analysis-actions, N11 | +L, N11 |
| 63 | Edit-and-adopt | N7 | N7 |
| 64 | Dismiss | ai-analysis-actions, suggestion-dismissal-reason, N11 | +L, N11 |
| 65 | Restore (Show) | ai-analysis-actions, N11 | +L, N11 |
| 66 | Toggle original | N7 (characterization) | N7 |
| 67 | Navigator j/k | ai-analysis-actions Navigation, N11 | +L, N11 |
| 68 | AI-panel finding click | comment-minimize nav, inline-feedback-context, N4, N11 | inline-feedback-context, N4, N11 |
| 69 | Panel quick actions | ai-analysis-actions Quick Action, N11 | +L, N11 |
| 70 | Panel comment click | edited-posted-comments "jumps to a comment", N11 | N11 |
| 71 | Analysis completion reload | ai-analysis | auto-analyze, ai-analysis-actions +L |
| 72 | External threads on anchor line, order | external-comments, N11 | — (external-comments asserts the segment is hidden) |
| 73 | Outdated and unanchorable fallbacks | external-comments | — |
| 74 | File-level threads | external-comments | — |
| 75 | Refresh without duplicates; segment; click | external-comments, N11 | — |
| 76 | Chat about external comment | external-comments | — |
| 77 | Resolved threads | not on main | not on main |
| 78 | External re-anchor after whitespace/refresh | N9 | — |
| 79 | Hunk summaries | hunk-summaries, N11 | hunk-summaries, N11 |
| 80 | Hash drift fails closed | N9, U | N9, U |
| 81 | Tour | tour, N11, M | tour, N11, M |
| 82 | Gutter chat button | chat-lines | chat-lines +L |
| 83 | Form Chat button | chat-lines | chat-lines +L |
| 84 | Chat file links | N8 | N8 |
| 85 | Header chat button | N3 | N3 |
| 86 | Minimizer | comment-minimize, N11 | comment-minimize +L, N11 |
| 87 | Whitespace toggle | lazy-diff whitespace test, N9 | N9 |
| 88 | Stale badge, refresh | stale-badge | N9 |
| 89 | Local scope change | — | N9 |
| 90 | Local base-branch selector | — | N9 (characterization) |
| 91 | Keyboard shortcuts | ai-analysis-actions j/k, tour, comment-crud Cmd+Enter, help-modal | tour, comment-crud +L, ai-analysis-actions +L |
| 92 | Text selection and copy | N10, M; find-in-page Q2 | N10, M; Q2 |
| 93 | Pointer-idle gating | N12, U | N12, U |
| 94 | Generation guards | N9 (rapid toggle), U | N9, U |
| 95 | Edited posted comments | edited-posted-comments, N11 | edited-posted-comments (Local test), N11 |
| 96 | Review history jump | edited-posted-comments, N11 | N11 |

## 10. Where a fresh implementation would re-discover the old attempt's bugs

| Old bug [OLD§c] | Prevented by | Caught by |
| --- | --- | --- |
| 1 `onPostRender` context from the wrong argument; the 1.6 `renderAnnotation` arity | Signatures from the probe | C1 arity tests |
| 2, 3 Refs or classes of a recycled host | Refs cleared, stamps reconciled (3.5) | C2 pooling test |
| 4 Zone in the sticky header | Zone is a `lineNumber: 0` annotation | C1 header-growth test, C2 zone test |
| 5 Tour exits, external threads demoted | Flush plus data oracle (3.8, 3.9) | tour and external-comments under the switch; C2 pending-swap test |
| 6 Sixfold slowdown | `bridge.batch` | L6; batch unit test |
| 7, 8 Counts from the DOM | Data-backed on main already | N11 |
| c2 Edit or delete reverted on remount | Delete removes the annotation; data first | phase-3 unit tests; N11 |
| c3 Wandering gap, landing errors, late header measurement | One static header token; vendor scroll targets | G9; validator pass; N4 |
| c4 Slot-waiter TDZ and teardown ordering | The registry does not exist | — |
| c4, c6 Cards dropped or duplicated in detached zones; Clear All leaving cards | Zone registry and grep test | N11 |
| c4, c6 Panel navigation no-op for evicted targets; target outside the line window | `revealInDiff` | N4, N11 |
| c4 Refresh wiped the diff; spinner detached the viewer | Array guard; `_setDiffStatus`; grep test | stale-badge, N9 |
| c4 Header icon empty after remount | `_syncFileHeader` on every header render | N11 |
| c5 Extent saga | Vendor resync [P§2]; nothing grows in the header | C1 extent test at max scroll; N11 zone-growth scenario |
| c5 Worker crashes from bare `waitForResponse`; port collisions | Transplanted infra | phase 1 |
| c6 Wrong external thread focused | Lookup by annotation id | N11 |
| c6 ChatPanel fallback dead | Data-backed `false` from `scrollToLine` | N8, unit |
| d6 No gutter buttons on context files | Legacy renderer unchanged (D2) | N5 |
| d11 `expandForSuggestion` needs a DOM wrapper | Its Pierre branch is deleted; reveal is data-only | N11 reveal on an unmounted file |

## 11. Phase log

### Phase 0: dependency bump to 1.6.4, alone (`de5d96e6`)

`package.json` pins `@pierre/diffs` to exactly `1.6.4`; lockfile has `@pierre/diffs@1.6.4` and `@pierre/highlights@0.4.0`; Shiki stays at 4.5.0. Unit 11316 / 11316. E2E 491 passed, 2 skipped, 1 failed (`gutter-buttons.spec.js:90`, the known flake), identical to the baseline on untouched main.

### Phase 1: test infrastructure, vendor contract suite, remaining gates

What was added:

- **Vendor bundle build.** `scripts/pierre-diffs-entry.mjs` exports `CodeView` and `hydratePartialDiff` in addition to the existing names. `scripts/build-pierre-diffs.mjs` stamps every bundle with `/*! @pierre/diffs@<version> <mode> */` and has a `--dev` flavour (`NODE_ENV=development`, unminified) written to `tests/.cache/pierre-diffs.dev.js` (gitignored). The development build is the only one in which the vendor's height validator exists.
- **L0.** `tests/unit/vendor-bundle-fresh.test.js` (the served bundle's stamp equals the installed version; the served worker is byte-identical to the installed one), `tests/unit/pierre-diffs-entry-exports.test.js` (the export list is pinned; every name production code and the contract suite read is exported), `tests/unit/e2e-console-guard.test.js`.
- **L1.** `playwright.contract.config.js`, `pnpm run test:contract`, `tests/contract/harness/` (a page and helpers ported from the probe harness; requests to a virtual origin are fulfilled from disk, so no port is bound; any undeclared `console.error` fails the test), `tests/contract/fixtures/workload.js` (a deterministic pure-JavaScript generator of a 59-file `git diff`-shaped patch with full old and new contents; checked once against real `git apply`: the 58 non-binary sections apply and reproduce the new contents exactly), 13 spec files under `tests/contract/vendor/` and 5 under `tests/contract/gates/`: 107 tests.
- **E2E infrastructure.** `tests/e2e/fixtures.js`: fallback to a kernel-assigned port on `EADDRINUSE`, awaited `server.close`, the console guard attached to every browser context, the `PR_ENGINE` init script, also on the context (inert until phase 5; an unknown value is an error), and the removal of the animation-disabling init script, which never worked (deviation below, hazard H41). `tests/e2e/console-guard.js`: the guard and its allow-list. `tests/e2e/test-server.js`: the database is closed when `listen` fails. `tests/e2e/helpers.js`: `expectResponse`, `expectRequest`, `cleanupComments`, `cleanupAllComments`.
- **`tests/CONVENTIONS.md`**: a Playwright E2E section and a vendor contract suite section, including the rule that a unit test may assert what we send to the vendor and never what the vendor does.

Results:

- `pnpm test`: 336 files, 11340 tests, all passing (11316 before, plus 24 new).
- `pnpm run test:contract`: 107 passed.
- `pnpm run test:e2e`, console guard on. Three runs on the final tree (after the animation init script was deleted): 491 passed / 2 skipped / 1 failed with `gutter-buttons:90` as the one failure, which is exactly phase 0 and the baseline, then 490 / 2 / 2 twice. Three runs before that deletion: 491 / 2 / 1, then 490 / 2 / 2 twice. Every failed spec passes when re-run alone, and the failure classes are ones the phase-0 tree shows as well; no run had a console-guard failure of its own (each run saw about 4,850 console errors, all allow-listed, apart from the one 500 that belongs to an already failing test). Details below.

Deviations from the plan in this phase, with the proof:

- **Spec files were touched.** The plan lists only the infrastructure files. The 41 `page.waitForResponse` / `page.waitForRequest` calls in 14 spec files, every one of them of the register-then-await shape, were converted to `expectResponse` / `expectRequest`. Phase 0's first run lost a worker to exactly this (`comment-crud.spec.js:553`, "worker process exited unexpectedly"), and helpers nobody calls would not have removed the cause. The change is mechanical and does not alter what any test asserts.
- **The fixture's animation-disabling init script was deleted; E2E runs with transitions on, as it always has.** Main's `fixtures.js` registered an init script that appended a `transition-duration: 0s !important` style to `document.head || document.documentElement`. An init script runs before the parser has created `<html>`, so both are null on every navigation, not only on `about:blank`: the script threw `TypeError: Cannot read properties of null (reading 'appendChild')` once per document and styled nothing, unseen until the guard existed. Proof: (1) the script instrumented to report what it sees, over one full run: 714 documents (490 `/pr`, 114 `/local`, 69 `/`, 17 `/settings`, 24 `about:blank`), every one with `readyState: "loading"` and no element to append to, 0 styled; (2) a probe on the phase-0 tree and on this one: 0 injected style elements and a computed `transition-duration` of `3s` for an element with `transition: opacity 3s`, in PR mode, after a reload and in Local mode. Deleting the script therefore changes no test's behaviour, and that is why it was deleted instead of repaired: the phase's bar is "E2E equal to phase 0", every baseline number was measured with transitions on, and production runs with them on. A working injection (a `MutationObserver` waiting for `<html>`; the probe then shows the style present and `0s`) was run twice over the full suite as an experiment and not adopted: 488 / 2 / 4 and 491 / 2 / 1, 1.7 minutes instead of 1.9 to 2.0. It broke nothing outright (no `transitionend` listener exists in `public/js`; the four `animationend` listeners still fire at zero duration), but the first run's failures included `edited-posted-comments:95`, which failed in no other run of this phase and was not investigated. Hazard H41 records what later phases must assume; question Q4 hands the choice to the user.
  - *Correction of the first report.* The first version of this phase kept the script with an early return when there was nothing to append to, and recorded that the error came from the initial `about:blank` document and that "real pages are styled as before". Both statements were wrong, and the early return turned a loud no-op into a silent one. Independent verification caught it; the paragraph above replaces it.
- **The `PR_ENGINE` init script is registered on the context, not the page** (the plan says `page.addInitScript`). Hazard H42 has the reason and the measurement.
- **The Playwright section of `tests/CONVENTIONS.md` is adapted, not verbatim.** The old branch's text refers to `whenAnnotationsSlotted`, which is not ported.
- **Corrections 1 to 9 in section 6**, each of which changes a later phase.
- **The workload is 59 files, not about 60**, and is generated in JavaScript instead of by git (as the plan requires). Tests refer to files by role, never by path.

Console guard: what main logs. One full run in record mode (`E2E_CONSOLE_GUARD=record`) collected 5,563 errors in 494 tests:

| Count | Message | Disposition |
| --- | --- | --- |
| 3,878 | Vendor parser reports on the shared fixture diff (`parsePatchContent: hunk line count mismatch`, `processFile: invalid rawLine`, `parseLineType: Invalid firstChar`) and on the generated diff in `lazy-diff.spec.js` | Allow-listed by exact message; hazard H36 |
| 720 | `WebSocket connection to 'ws://localhost:<port>/ws' failed` | Allow-listed: the E2E server mounts no WebSocket endpoint |
| 714 | `TypeError: Cannot read properties of null (reading 'appendChild')` from the fixture's animation-disabling init script, once per document loaded (not once per test) | Script deleted: it had never styled a document (hazard H41) |
| 206 | `... TypeError: Failed to fetch` (comments, context files, file contents, viewed state, files, recent reviews) | Allow-listed: an in-flight fetch aborted by a navigation or by the page closing |
| 20 | `POST /api/local/2/refresh` 500 and its frontend log line | Allow-listed: the Local fixture review points at a worktree that does not exist |
| 23 | 404s and their frontend log lines in tests that provoke them (non-existent PR, mock analysis ids, missing stored config, a failed update) | Allow-listed, each by URL |
| 2 | `DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong {file: q.sql}` | Allow-listed; hazard H37 |

With that script gone and the allow-list in place the guard reported nothing in any later full run, except twice on a test that was already failing for its own reason (`split-view.spec.js:746`: its `cleanupAISuggestions` call gets a 500 from `/api/reviews/1/ai-suggestions` under load and throws; the guard then reports the same 500. A known flake that passes alone).

E2E runs in this phase. The machine was shared with other sessions; its load average was between 8 and 17 by the end of every full run.

| Run | Passed / skipped / failed | Failed tests |
| --- | --- | --- |
| Baseline (untouched main) | 491 / 2 / 1 | `gutter-buttons:90` |
| Phase 0, runs 1 and 2 | 490 / 2 / 2, 491 / 2 / 1 | `gutter-buttons:90`; `comment-crud:553` (worker crash from a bare `waitForResponse`) |
| Phase 1, survey run (guard recording only) | 489 / 2 / 3 | `gutter-buttons:90`, `comment-crud:311`, `comment-crud:439` |
| Phase 1, run 1 | 488 / 2 / 4 | `gutter-buttons:90`, `comment-crud:41`, `inline-feedback-context:81`, `inline-feedback-context:123` |
| Phase 1, run 2 | 489 / 2 / 3 | `external-comments:465`, `comments-review:29`, `split-view:746` |
| Phase 1, run 3 (final E2E code) | 491 / 2 / 1 | `comment-crud:439` |
| Phase 1, run 4 (final E2E code) | 490 / 2 / 2 | `gutter-buttons:90`, `inline-feedback-context:81` |
| Phase 1, run 5 | 490 / 2 / 2 | `inline-feedback-context:123`, `comment-crud:553` |
| Phase 1 round 2, census run (init script instrumented, guard recording only) | 490 / 2 / 2 | `gutter-buttons:90`, `comment-crud:76` |
| Phase 1 round 2, experiment: transitions really off, runs 1 and 2 (not adopted) | 488 / 2 / 4, 491 / 2 / 1 | `gutter-buttons:90`, `comment-crud:522`, `edited-posted-comments:95`, `inline-feedback-context:81`; `gutter-buttons:90` |
| Phase 1 round 2, final tree, run 1 | 491 / 2 / 1 | `gutter-buttons:90` |
| Phase 1 round 2, final tree, run 2 | 490 / 2 / 2 | `comment-crud:41`, `split-view:746` |
| Phase 1 round 2, final tree, run 3 | 490 / 2 / 2 | `comments-review:42`, `gutter-buttons:98` |

Runs 1 to 5 were made with the animation init script still present (throwing in the survey run, returning early afterwards). The census proves the script styled no document in either form, so those runs and the round-2 runs on the final tree measure the same page behaviour.

The failure set changes from run to run, which is the definition of flake used here, and every failed spec was re-run alone:

- `comment-crud`, `comments-review`, `external-comments`, `split-view`: pass alone (`--workers=1`), `comment-crud` three times, and its multi-line test 12 of 12 with `--repeat-each=12`. Their failures under load are the fallback gutter intercepting the click (30 s timeouts) and, for `comment-crud:439`, a selection set through `fileState.instance` being lost when the idle content upgrade re-renders the file.
- `inline-feedback-context` does **not** always pass alone, and that was checked against the phase-0 tree instead of being assumed. With `--workers=1 --repeat-each=10` (80 executions per run, machine load 2 to 4): the phase-0 tree (`git archive HEAD`, its own vendor bundle) failed 0, 3, 2, 1 and 2 of 80; this tree failed 6, 2, 1, 1, 1 and 0 of 80 (the last four with the phase-0 bundle or with the guard switched off, to bisect). That is 8 of 400 against 11 of 480, about 2% each. The failing test is `:123` "suggestions spanning a visible hunk and hidden endpoint render and navigate", which holds worker messages back and asserts a card stays hidden; `:81` fails the same way under load (5 of 144 on the phase-0 tree, 2 of 144 on this one, 8 workers). It is a flake that main already has and that the list of known flakes did not contain. Phase 2 rewrites this spec's vendor access behind helpers and should remove the race.
- Under an 8-worker stress of `inline-feedback-context` plus `comment-crud` (140 executions per run) the phase-0 tree failed 2 and 2, this tree 4 and 1.
- Round 2, final tree: `comment-crud` (20 of 20), `split-view` (20 of 20), `comments-review` (16 of 16) and `gutter-buttons` (6 of 6, then 60 of 60 with `--repeat-each=10`) pass alone. `comment-crud:41`, `comment-crud:76` and `comments-review:42` are the fallback gutter intercepting the click again; `gutter-buttons:98` timed out in its setup (`setDiffView` waiting 5 s for the split layout) at a load average of 13, in the spec that already holds the known flake `:90`.
- `comment-crud:553` in run 5 is the test whose bare `waitForResponse` crashed a whole worker in phase 0's first run. With `expectResponse` the same timeout under load now fails that one test and nothing else.

Open items carried forward:

- **For the user: Q1 (context files after the changed files, decision D2) and Q2 (find-in-page only sees mounted files) are still open.** Work proceeds on the defaults; phase 5 is the first phase that depends on Q1.
- **For the user: Q4, transitions in E2E.** The suite runs with CSS transitions and animations on (hazard H41); the fixture's attempt to switch them off never worked and was removed. Later phases write their specs for transitions on. Switching them off for real is possible (measured: nothing breaks outright, about 10% faster) but re-times all 494 tests and is not part of this migration unless asked for.
- **The contract suite is not run by CI.** `.github/workflows/test.yml` runs `pnpm test` and `pnpm run test:e2e`. Adding `pnpm run test:contract` to the E2E job (it needs the same Chromium install, about one minute) is what makes "the contract suite gates every bump" true for a bump made outside this migration. Not changed here because the workflow file is outside this phase's scope.
- **The shared fixture diff is malformed** (hazard H36). Phase 2 decides whether to fix it, and must check `hydratePartialDiff` against it either way.
- **`inline-feedback-context.spec.js` is flaky on main at about 2% per execution**, alone and at one worker. Phase 2 moves its vendor access behind helpers; the race should be removed there, and until then a failure of `:81` or `:123` in a full run is re-run alone before it is read as a regression.
- **Corrections 1, 2, 4, 5 and 9 change the bridge's design** (two item metrics, no vertical padding on the root, the row-less CSS, the displayed-diff signal, the line-anchored restore). Phase 4 implements them as written in section 6; the plan document's sections 3.2, 3.4, 3.7, 3.10 and its fact table are superseded on those points.
