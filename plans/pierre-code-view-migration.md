# Migrate diff rendering to @pierre/diffs CodeView

## Goal

Replace the per-file `FileDiff` instances + hand-rolled virtualization (lazy
IntersectionObserver, minHeight reservation, render-budget deferral) with a
single `CodeView` instance that owns the diff list and virtualizes natively.
Keep the `PierreBridge` public API stable so consumers (suggestion-manager,
hunk-summary-renderer, tour-renderer, external-comment-manager, ChatPanel,
comment-minimizer) change minimally. Both PR mode and Local mode use the same
PRManager/bridge, so one migration covers both — but both must be verified.

## Status

- [x] Phase 1: `CodeView` exported from `scripts/pierre-diffs-entry.mjs`,
      vendor bundle rebuilt (`window.PierreDiffs.CodeView` available).
- [x] Phase 2: core rewrite (pierre-bridge.js + pr.js render pipeline)
- [x] Phase 3: consumers audit + unit tests + E2E helpers/specs + CSS cleanup
- [x] Phase 4: integration review (read-only agent) — verdict FIX-FIRST;
      both findings (edit/delete remount sync) fixed as Task #14
- [x] Phase 5: full test suite + E2E green, changeset
      (`.changeset/codeview-virtualized-diff.md`, minor)

## Review-feedback round 2 (2026-07-29/30)

17 findings, all addressed (unit 9,284 green; E2E 419/423 with only the
rotating saturation class):
- Production: shared `_markCommentDeleted` (delete invariant was split across
  two files, each owning half); `_instanceToId` recreate leak; teardown
  waiter-array snapshot (+ `element:null` shape align); item-metric probe
  iterates past row-less/binary first hosts; diff-wins guard made order-proof
  (`diffFiles` null sentinel); dead vendor re-exports pruned to the five
  consumed names (bundle rebuilt; export surface pinned by a unit test).
- THE EXTENT SAGA (three theories, resolved by measurement): opening the
  file-comment form never grows the DOM scroll extent — the vendor's resize
  path reconciles item heights but only render passes call
  `syncContainerHeight` (CodeView.js:1316→1284). Tall last file at max scroll
  = Save unreachable. Fix: `syncScrollExtent()` = queued `render(false)`,
  driven by one shared ResizeObserver over the cached file-comment zones (no
  first-fire skip — the skip design had a latent hole for zones born
  virtualized-out). Line-form autogrow self-heals CONDITIONALLY — only when
  the caret is pushed out of view (caret-driven scroll → render); caret-
  visible growth leaves a recoverable extent gap, and non-caret-moving growth
  at max scroll (error banner / preview toggle, if added later) would need
  the observer extended to line forms. Observation built, A/B'd, reverted;
  dependency documented at pr.js:4447 and pinned by an E2E guard with a
  KNOWN GAP note.
- E2E infra: 45 bare waitForResponse/waitForRequest sites → guarded
  expectResponse/expectRequest helpers (worker-crash insurance; measured NOT
  a flake fix); EADDRINUSE on the fixed per-worker port was producing
  multi-spec ~1ms failures — port fallback + awaited close in fixtures.js
  (first proven mechanism in the rotating-flake class); extent-delta contract
  test (bite-verified in every geometry — button visibility was green through
  the entire broken period); new Playwright section in tests/CONVENTIONS.md.

## Post-migration review-feedback batch (2026-07-18)

An external review pass surfaced 15 findings; all fixed and regression-covered
(unit 9,231 green; E2E green minus the documented saturation class):
- CRITICAL: TDZ ReferenceError in `whenAnnotationSlotted` (waiter referenced
  before declaration on the synchronous fast path with a concurrent pending
  waiter).
- Context-file contract unified behind `_pierreItemIdForPath` (hydration
  await id, virtualization-independent file-comment hydration via
  getOrCreate zones, file-comments annotation upsert, `scrollToContextFile`
  CodeView branch).
- `this.userComments` optimistic staleness fixed via
  `_registerOptimisticUserComment` (adoption + file-level create).
- Panel navigation materializes virtualized-out targets for external
  threads, user comments, and findings via shared
  `_ensureNavTargetRendered`; user-comment path additionally fixed for an
  unscoped `[data-comment-id]` selector matching the panel's own button.
- Empty-review placeholder + guard: only an explicit empty `changed_files`
  array renders "No files changed"; undefined keeps the current view.
- refreshPR-under-CodeView every-refresh hang: spinner wipe guarded, and
  `_ensureCodeView` now re-setups when its managed container was externally
  detached (second external-wipe incident — bridge defends the class).
- Deleted-file file-comment side derived from GitHub `status === 'removed'`
  (API patches carry no git header); header comment icon re-synced on
  remount; `_recreateCodeViewMainThread` clears all four host refs;
  `_flashLine` bounded-poll for late mounts.
- Test-layer: FakeCodeView auto-flush sentinel, container-scroll assertion,
  E2E isolation for the Comment Display block, `codeview-behaviors.spec.js`
  (9 behaviors) + host-scoped `openCommentFormOnLine`.

Seven production bugs were found by live E2E probing and fixed during the
migration (none were caught by unit tests whose fakes mirrored our own
assumptions — the fake was subsequently made faithful for each):
1. `onPostRender` context is arg 4, not arg 3 (host refs never captured).
2. Unmount must clear `_element`/`_instance`/`_shadowRoot` (pooled hosts get
   restamped for other files).
3. Per-file host classes must apply on mount and strip on recycle.
4. File-comments zone in the sticky header intercepted clicks — moved to a
   `lineNumber: 0` file-level annotation; legacy header sticky neutralized.
5. Annotations slot on the next rAF, not synchronously — consumers await
   `whenAnnotationSlotted`/`addAnnotationsAndAwait`; external comments use the
   `isLineVisible` metadata oracle before demoting to file-level.
6. Serial add+await caused ~6x perf regression — per-file batched publishes;
   content upgrades defer while the pointer is over the file.
7. DOM-query comment counts undercounted virtualized-out comments —
   data-backed `_countActiveUserComments`; single edit/delete now sync the
   annotation data model (Task #14) so remounts don't revert/resurrect.
8. Two stragglers of bug 7 fixed after live testing: the guard + dialog
   count inside `clearAllUserComments()` (falsely toasted "No comments to
   clear" when commented files were virtualized out) and ReviewModal's
   comment count / REQUEST_CHANGES validation (now via
   `getActiveCommentCount()` → `prManager._countActiveUserComments()`).
   Live-validated in both Local and PR mode (real GitHub PR #553 drive);
   regression E2E in comment-remount.spec.js runs in both modes.

## Full-migration live validation round (2026-08-08)

Four real-app Playwright drives (not the fixture server) on top of green
suites (9,299 unit; full E2E with the 5 contention flakes cleared solo).
Zero console/page errors in all four. No migration regressions found.
- Core (Local): rendering parity exact vs `git diff` (3 files, cell-level),
  virtualization recycling (max 2 hosts), jump-to-file ≤28px, split toggle
  0px drift, context-expansion line numbers exact, theme, full comment
  matrix, extent-guard Save reachable at max scroll (extent 32000→32230).
- Edge files (Local): rename/delete/binary/empty/no-newline/2615-char
  lines/unicode/CRLF all render safely; deleted-file comments store
  side=LEFT and re-anchor. Two PRE-EXISTING local-mode gaps found (local.js
  never sets `renamed`/`renamedFrom` or `binary`; `binaryMessage` has no
  render site anywhere) — follow-ups, not regressions.
- PR mode (real GitHub PR #554, closed after): external thread inline +
  panel nav to evicted thread, gutter reveal/hide, stale badge after a real
  push, refresh pulls new commit (8→9 files) with comment survival,
  file-level comment lands as subject_type=file, real COMMENT review
  submit verified via API.
- AI analysis (real claude CLI run, Local): finding anchored exactly on the
  planted line, panel nav from evicted file, adopt (optimistic user-comment
  registration), dismiss-via-delete, reload rehydrates adopted and
  dismissed states.
Not live-driven (fixture-covered by green E2E): tours, chat panel, hunk
summaries, comment-minimizer.

## Review-feedback round 3 (2026-08-09)

Seventeen findings from an external review of the full migration diff, all
addressed (fixes by six parallel agents partitioned by file; combined
suites re-run after merge: 9,349 unit green, targeted E2E green).

- **AIPanel nav**: triplicated preamble (expand → render → gen-guard)
  folded into `_ensureNavTargetRendered`; added bounded row poll
  (`NAV_ROW_MAX_FRAMES`, `_navGen` re-checked in-loop) because
  `whenAnnotationsSlotted` answers about the FILE item and resolves in one
  frame for a mounted file whose target LINE is outside the render window
  — nav used to check `findRow()` once and silently no-op. `_findExternalRow`
  gained `strict` so the materialize gate can't accept an unrelated row
  (wrong-thread focus).
- **external-comment-manager**: `clear()` now sweeps document + every
  cached `_fileCommentZones` zone (detached zones held rows that escaped a
  document-only sweep → duplicate cards on scroll-in). `not-mounted`
  verdict now validates the anchor via `_anchorLineInDiff` when hunk
  metadata exists (stale anchors on off-screen files used to be kept
  forever, permanently invisible); no-metadata-yet still keeps.
- **file-comment-manager**: `adoptAISuggestion` and `adoptWithEdit` now
  call `_registerOptimisticUserComment` (data-backed count was off by one
  after file-level adoption until reload).
- **pierre-bridge**: `scrollToLine` returns false from parsed diff data
  when the line isn't in the file (`_lineInDiffData`; undecidable stays
  optimistic) — restores ChatPanel's scrollToFile fallback that had become
  dead code. Dead `expandHunk`/`onHunkExpand` surface deleted (bridge +
  pr.js). Slot-waiter machinery unified into `_awaitSlot` (both public
  waiters are thin probes; TDZ-safe ordering preserved). dragInfo guard
  rationale comment restored.
- **pr.js**: pointer-deferred content upgrade caches fetched contents
  (`_deferredUpgradeContents`, cleared on success and on both
  `_fileContentsAbort` replacement paths) instead of re-fetching per retry.
  TOTAL highlight budget removed (`_pierreRenderBudget`) — virtualization
  bounds highlighting to mounted items, the pool drained in file-list
  order and permanently downgraded files the user views; per-file and
  auto-render caps kept. **High**: `_purgeFileCommentCards` zone-aware
  sweep used by Clear All and `deleteUserComment` — file-level cards in
  detached cached zones used to survive both and resurrect on scroll-in.
  Context-file jump now shares `_scrollToPierreItemWithStickyOffset` with
  the diff-file jump (was missing sticky-header compensation).
- **Tests**: `test.slow()` on all 20k-fixture codeview-behaviors tests;
  `cleanupComments`/`cleanupAllComments`/`evictionDiff`/
  `hoverUntilGutterVisible` consolidated into e2e/helpers.js; nav-scroll
  tautological length assertion removed. New unit coverage: nav row poll,
  strict external gate, detached-zone external sweep, not-mounted anchor
  validation, adoption registration, scrollToLine false, deferral cache,
  zone purge (file-comment-zone-purge.test.js).
- Post-merge correction: the strengthened gutter "reveals" test asserted
  the CHAT button becomes sized, but the fixture server configures no chat
  provider — `<html data-chat="unavailable">` hides `.pierre-chat-btn` via
  CSS by design, so that assertion can never pass. Rewritten to poll the
  comment button sized and assert the chat gate explicitly (attached +
  hidden when gated, sized when not). Probe lesson: `.pierre-gutter-buttons`
  must be scoped to the hovered file's OWN host — with two hosts mounted,
  a document-first query measures the other file's (0x0) container.

## Target architecture

**Scroll container.** `#diff-container` becomes the CodeView root via
`codeView.setup(root)`. `.diff-view` stops scrolling (`overflow` hidden);
`#diff-container` gets `flex: 1; min-height: 0`. The sticky `.diff-toolbar`
stays above it inside `.diff-view` and no longer needs `position: sticky`.
Anything that reads/preserves `.diff-view.scrollTop` (split/unified toggle at
pr.js:2863, scroll-margin math `_measureFileHeaderHeight`) must be reworked
against CodeView APIs (`getScrollTop`, `scrollTo({type:'position'})`).

**Items.** One `CodeViewDiffItem` per changed file, `id` = file path,
`fileDiff` = the parsed `FileDiffMetadata` (same object pierre-context.js
manipulates today). Context files (`loadContextFiles`) become
`CodeViewFileItem`s with `id = 'context:<path>'` appended after diff items —
replacing the legacy `.d2h-diff-table` rendering in `renderContextFile`.
Binary files become diff items with zero hunks (header-only) rendered through
the same custom-header path, replacing `renderBinaryFile`'s custom DOM.

**Headers.** `renderCustomHeader(fileDiff, context)` returns our existing
header built by `DiffRenderer.createFileHeader` (viewed checkbox, collapse
chevron, stats, comment/chat/summary buttons) plus the file-comments zone
(`fileCommentManager.createFileCommentsZone`). Keep `stickyHeaders: true`
only if the file-comments zone can live outside the sticky region — verify
empirically; if the whole custom header sticks, move the comments zone to a
file-level annotation instead (verify `lineNumber: 0` file-level annotation
support for diff items; fall back to a non-sticky header if unsupported).

**Annotations.** Bridge keeps per-file annotation arrays keyed by item id.
Rendering goes through CodeView's `renderAnnotation(annotation, context)`
callback, which dispatches on `annotation.metadata.type` to the existing
renderer registry (`comment`, `comment-form`, `suggestion`, `hunk-summary`,
`tour-stop`, `external-comment`). Every annotation element MUST stay wrapped
in the light-DOM `[data-annotation-slot]` wrapper — comment-minimizer and the
E2E helpers depend on it. Publishing annotation changes = `updateItem` with
`version` bumped (replaces `setLineAnnotations` + `rerender`).

**Gutter buttons & selection.** Replace hand-rolled gutter buttons and
drag-select with `enableGutterUtility` + `renderGutterUtility` +
`onGutterUtilityClick` and `enableLineSelection` + selection callbacks
(`onLineSelected`, `onSelectedLinesChange`). Preserve the visible classes
(`.pierre-gutter-btn`, `.pierre-comment-btn`, `.pierre-chat-btn`) so CSS and
E2E selectors keep working, or update both in lockstep.

**Collapse / viewed.** Per-item `collapsed` flag via `updateItem`. The CSS
`display:none` hack on `.pierre-diff-body` dies with the per-file cards.
`toggleFileCollapse` / `toggleFileViewed` call the bridge, which updates the
item; header UI (chevron, checkbox) stays ours. Initial collapsed state
(generated/viewed/persisted) is set on the items at `setItems` time.

**Deferral & budgets.** Delete `deferDiff`, `_createDeferredDiffPlaceholder`,
`_materializeDeferredDiff`, `_renderDeferredDiff`, `_lazyFileBodies`,
`_fileBodyObserver`, `ensureFileBodyRendered` (calls become no-ops or direct
item lookups), `APPROX_DIFF_LINE_PX` reservation. KEEP the `forcePlainText`
highlight budget (`metadata.lang = 'text'`) — that is orthogonal to
virtualization and protects the tokenizer.

**Scrolling.** `scrollToFile` → `codeView.scrollTo({type:'item', id})`;
scroll-to-line → `{type:'line', id, lineNumber, side}`. The
`ScrollUtils.scrollIntoViewStable` re-correction dance is obsolete for diff
navigation (CodeView layout is measured, not lazily shifting).

**Hunk expansion / full contents.** `upgradeFileContents` keeps fetching
old/new contents from `/api/reviews/:id/file-contents/…`, then produces a
non-partial `FileDiffMetadata` (`isPartial: false`, full
`deletionLines`/`additionLines`) and publishes via `updateItem` + version
bump. Investigate `parseDiffFromFile` (already bundled) for building it.
Per-hunk expand-arrow behavior comes from `context.instance.expandHunk` on
the `VirtualizedFileDiff`. pierre-context.js range math is unchanged (same
metadata shape) — context ranges also publish via `updateItem`.

**Theme / diffStyle / worker.** `themeType` pass-through + `onThemeChange()`;
`setDiffStyle` = one `setOptions({diffStyle})` on the CodeView (verify
whether an explicit `render()` is needed after). The existing
`WorkerPoolManager` (and its main-thread fallback path) passes as the second
CodeView constructor arg.

**Legacy fallback.** When `window.PierreDiffs` is missing the bridge is
`null` and pr.js keeps the existing diff2html table pipeline (per-file cards,
lazy observer). That code stays; `renderDiff` branches once at the top:
CodeView path (no per-file cards) vs legacy path (unchanged).

## Bridge API changes (the only contract break)

- NEW `renderAll(root, files, options)` (or `setFiles`) replaces per-file
  `renderFile(file, container)` / `renderBinaryFile`.
- `destroyAll` → `codeView.cleanUp()` + state reset.
- Everything else keeps its signature: `addAnnotation(s)`, `removeAnnotation`,
  `removeAnnotationsByType`, `getAnnotations`, `registerRenderer`,
  `addContextRanges`, `clearContextRanges`, `convertOldToNew`,
  `isLineVisible`, `scrollToLine`, `getDiffPosition`, `getCodeFromLines`,
  `setDiffStyle`, `setTheme`, `setCollapsed`, `upgradeFileContents`,
  `isPointerOverFile`, `files` map (now item-state records).

## Hazards

- **`setCollapsed`** (pierre-bridge.js:1014) callers: `toggleFileCollapse`
  (pr.js:5096), `toggleFileViewed` (pr.js:5129) — both gate on
  `pierreBridge.files.has(filePath)` because unrendered bodies had no
  instance. Under CodeView every file has an item immediately; the gate's
  meaning changes. The old expand path forced `rerender()` because a
  collapsed-rendered FileDiff emitted zero rows — verify CodeView expands a
  `collapsed:true→false` item correctly without manual re-kick.
- **`ensureFileBodyRendered`** callers: `toggleFileCollapse`,
  `toggleFileViewed`, `scrollToFile` (pr.js:7889), comment/suggestion
  anchoring paths (`ensureLinesVisible`, `expandForSuggestion`). Each assumed
  lazy bodies might be empty. Removal must handle every caller — with
  CodeView, annotation anchoring on a not-yet-rendered (virtualized-out) item
  must still work because annotations live on item data, not DOM.
- **Async races.** `_materializeDeferredDiff` deduped concurrent renders via
  `_deferredDiffRenderPromises` and bailed if `renderDiff` re-ran mid-flight.
  Its replacement (`setItems` on re-render) must tolerate: analysis results
  arriving during initial render, split-toggle during content upgrade,
  `upgradeFileContents` resolving after a `setItems` wiped/replaced items
  (stale version writes — always re-`getItem` before `updateItem`).
- **Annotation re-render loop.** Custom renderers (`hunk-summary-renderer`,
  `tour-renderer`, `external-comment-manager`) are re-invoked on every
  rerender and guard with one-time flags. CodeView re-invokes
  `renderAnnotation` on virtualization remount — renderers must be
  idempotent per remount, not per page-load (the one-time-flag pattern
  breaks: an element detached by virtualization must be re-createable).
- **comment-minimizer** operates on light-DOM `[data-annotation-slot]`
  wrappers without bridge calls — wrapper structure must survive, and
  minimized state must survive virtualization remounts (state must live in
  data, not DOM).
- **Context-file collapse namespacing** (`_contextStateKey` = `context:<path>`,
  `findContextFileWrapper`) exists because a context entry can share
  `data-file-name` with a diff entry (fix #540). Item ids `path` vs
  `context:path` preserve the separation — keep it.
- **Split-toggle scroll preservation** (pr.js:2863) reads
  `.diff-view.scrollTop` — container changes to CodeView-managed root.
- **Local mode parity**: `local.js` reads
  `manager.pierreBridge && !manager.pierreBridge._disabled`; every renamed
  bridge member must keep that capability probe true. Verify local mode E2E.
- **E2E helper contracts** (`tests/e2e/helpers.js`): gate on
  `.pierre-diff-body diffs-container` → `[data-line]`,
  `pre[data-diff-type]`, `.pierre-comment-btn`, annotation-slot checks.
  CodeView pools/reuses `<diffs-container>` elements — helpers must anchor on
  item ids, not stable per-file hosts.
- **Unit-test stubs**: 13 pierre-* unit test files hand-stub
  `window.PierreDiffs` with fake `FileDiff`/`WorkerPoolManager`; they need a
  fake `CodeView` mirroring the real reconciliation semantics (`version`
  gating in `updateItem`).
- **`hunkSeparators: 'custom'` is not supported by CodeView** — if the bridge
  or hunk-summary rendering uses custom separators, port to annotations.
