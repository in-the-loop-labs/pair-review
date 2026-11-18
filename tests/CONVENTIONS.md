# Test Conventions

Rules distilled from the 2026-07 de-flake of the suite (PR #523). Tests run
under vitest with `pool: 'forks'`: test **files** run in **parallel forked
processes**; tests within a file run sequentially. Every rule below exists
because violating it produced a real, observed flake or measurable waste.

## HTTP and supertest

- **Never pass a bare Express app to supertest.** `request(app)` binds a
  wildcard-address server per request but dials `127.0.0.1` — the kernel
  (observed on macOS) can assign that wildcard listener an ephemeral port a
  foreign process already holds on `127.0.0.1`, which then answers the test's
  request (seen: wrong statuses, `Parse Error: Expected HTTP/`, socket
  hang-ups). Use the shared helper:
  ```js
  const { listenOnLoopback, closeServer } = require('../utils/loopback-server');
  // beforeEach: server = await listenOnLoopback(app);
  // afterEach:  await closeServer(server);
  // tests:      request(server)...
  ```
- Any raw `http.createServer(...).listen(...)` in a test must bind
  `'127.0.0.1'` explicitly (never a bare `listen(0)`), and its close must be
  awaited in a `finally` or teardown hook.

## Waiting for async work

- **Never wait a fixed duration for async work.** A `setTimeout(r, 50)` that
  passes locally races real I/O (TCP, fs, subprocesses) and loses on loaded CI
  runners. In preference order:
  1. Await the actual promise or event: `await once(emitter, 'event')`.
  2. Poll a deterministic completion signal with a generous deadline:
     `await vi.waitFor(() => expect(...).toBe(...))` — fast when healthy, slow
     only when broken.
  3. For microtask/next-tick chains only: `await new Promise(setImmediate)`.
- **Negative assertions ("X never arrives") must not use observation
  windows.** Sleeping 100ms and checking nothing arrived proves nothing.
  Use a sentinel: trigger the forbidden thing first, then a sentinel on the
  same ordered channel; when the sentinel arrives, assert the forbidden thing
  did not (see `tests/unit/ws-server.test.js`).
- **Production delays (retry/backoff sleeps) must be elapsed with fake
  timers**, never waited out. Wrap in `try { vi.useFakeTimers(); ...;
  await vi.runAllTimersAsync(); } finally { vi.useRealTimers(); }` — the
  `finally` is mandatory or a failing assertion leaks fake timers into every
  later test in the file. Pattern: `runWithFakeRetryDelay` in
  `tests/unit/github-client.test.js`.

## Timestamps

- **Never assert `updated_at >= before` after a small sleep.** SQLite
  `CURRENT_TIMESTAMP` has 1-second resolution, so `>=` passes on equality and
  the test can never catch the regression it exists for. Backdate the row via
  SQL (`UPDATE ... SET updated_at = '2020-01-01 00:00:00'`), run the
  operation, assert **strictly greater**.

## Isolation across parallel forks

- **No fixed filesystem paths.** Files run concurrently in separate
  processes; two files touching the same path collide. Always
  `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))` per file (or per
  test). `Date.now()` suffixes are not uniqueness.
- **Tests that spawn the CLI must set an isolated `HOME`** (mkdtemp) in the
  child env — otherwise the child reads/creates the developer's real
  `~/.pair-review`. Where token lookup could shell out, prepend a fake
  failing `gh` to `PATH` (pattern in `tests/integration/first-run.test.js`).
- **No real network. Ever.** Mock every GitHub/API/git-clone path. A test
  that works only when github.com answers is a flake with extra steps.

## Browser globals (jsdom)

- **Do not rely on jsdom's ambient `localStorage`/`sessionStorage`.** Node 22.4+
  (flagged) and Node 26 (default-on) expose the Web Storage API as a global.
  That global pre-exists the jsdom environment, so vitest's `populateGlobal`
  sees the key already present and skips copying jsdom's real `localStorage`
  onto `window`; the leftover native accessor reads back `undefined` (or throws
  under `--experimental-webstorage`). Result: a `@vitest-environment jsdom`
  test that calls `window.localStorage.clear()` passes on Node 24 and fails on
  Node 26 — a version-correlated flake, not fork ordering. A shared setup file
  (`tests/setup/web-storage-polyfill.js`, wired via `setupFiles`) installs a
  configurable in-memory Storage so jsdom tests are Node-version-agnostic.
  Reproduce the Node 26 condition on any Node with
  `NODE_OPTIONS="--experimental-webstorage --localstorage-file=$(mktemp)"`.

## Mock hygiene

- **Do not call `vi.clearAllMocks()` in files that create many `vi.fn()` per
  test.** It walks the registry of every mock ever created in the process —
  with ~700 new mocks per test that is O(n²) (measured: one file went
  14ms→141ms per test, 37s total). Clear an explicit, fixed set of
  module-level mocks instead (`clearModuleLevelMocks()` in
  `tests/unit/chat-panel.test.js`).
- `vi.clearAllMocks()` clears **call history only** — it does not reset
  implementations and does not flush unconsumed `mockResolvedValueOnce`
  queues. If a file sets persistent overrides inside test bodies, re-arm all
  defaults after every clear (`applyDefaultMocks()` in
  `tests/integration/routes.test.js`).

## Playwright E2E

- **Never run two Playwright E2E processes at once.** Every run binds
  `4000 + workerIndex`; two runs share one server and one SQLite database and
  corrupt each other. The fixture falls back to a kernel-assigned port when its
  preferred one is taken (a back-to-back run whose socket has not been released
  yet), which stops the `EADDRINUSE` failure, not the sharing.
- **A pending `page.waitForResponse` / `waitForRequest` kills the whole worker.**
  Both are registered *before* the action that triggers them, so there is always
  a window before the `await`. If anything in that window fails (a click that
  times out, a failed assertion, the test deadline), the still-pending promise
  rejects unhandled. That does not merely fail the test: Playwright reports
  `worker process exited unexpectedly (code=1)` and every remaining test in that
  file fails at 0 ms, so the run's failure set reshuffles by which worker died.
  Use `expectResponse` / `expectRequest` from `tests/e2e/helpers.js`. They
  attach the no-op catch and return the same promise, so awaiting it still
  reports a genuinely missing response.
- **A `console.error` or an uncaught page error fails the test.** The guard in
  `tests/e2e/console-guard.js` is attached to every browser context by
  `tests/e2e/fixtures.js`. The frontend reaches a bundled vendor component
  through callbacks, and a mismatch there does not fail a locator: it logs a
  TypeError and the feature renders nothing. Fix the source of a new error. Add
  to `ALLOWED` only a message the app logs on purpose in a flow the test
  exercises on purpose, with the reason, and with a `url` pattern when the text
  alone does not identify the request ("Failed to load resource" never does).
  `E2E_CONSOLE_GUARD=record E2E_CONSOLE_LOG=<file>` surveys without failing.
- **CSS transitions and animations are ON in E2E, as in production.** Nothing
  in the fixture disables them. (It used to carry an init script meant to; the
  script ran before `<html>` existed, threw on every navigation and never
  styled a single document, so every result the suite has produced was measured
  with transitions on. It was deleted.) The AI panel animates its width
  (0.2 s), popovers and badges fade in (0.15 s), and a highlighted line keeps
  its class until `animationend` (3.5 s). A value read once
  right after the class change that starts a transition is a mid-transition
  value: poll for the settled one (`expect.poll`, `toHaveCSS`, the `expect`
  retrying matchers). The AI panel's width transition resizes the diff, which
  re-wraps lines and moves everything below, so geometry is measured only after
  the width has stopped changing. An init script cannot append to
  `document.head` or `document.documentElement`: both are null when it runs.
- **`tests/e2e/diff-dom.js` is the only E2E file that knows vendor DOM.** A
  spec never names `diffs-container`, a shadow root, `.pierre-diff-body`, a
  vendor row attribute (`data-line`, `data-column-number`, `data-separator`,
  `data-expand-*`, `data-additions`, `data-diff-type`,
  `data-annotation-slot`, ...), `prManager.pierreBridge` or
  `window.PierreDiffs`; it asks `diff-dom.js` (`rows`, `lineNumberCell`,
  `fileLayout`, `selectLineRange`, `contextFileState`, ...).
  `tests/unit/e2e-vendor-dom-boundary.test.js` fails otherwise, comments
  included. The same specs must run unchanged against two diff engines; when
  the engine changes, that one file changes. A spec may name what the
  application owns on both engines: `.d2h-file-wrapper[data-file-name]`,
  `.d2h-file-header`, card classes, `.pierre-comment-btn`, `#diff-container`.
  The same test forbids `inPage` / `waitInPage` and the fields of the bridge's
  file record (`baseMetadata`, `fileDiff`, `getRenderedDiff`) outside
  `diff-dom.js`: a callback handed the page-side adapter reads engine state
  under another name. A spec that needs a new question asked of the engine
  gets a named helper in `diff-dom.js` (`contentsApplied`,
  `upgradeAwaitingDisplay`, `firstFileBelowToolbar`).
- **A diff a test serves comes with the contents it was taken from.** The
  frontend fetches a file's full contents after rendering its patch and
  upgrades the diff with them. Contents that do not belong to the patch
  re-lay the file out with a different diff and make the vendor log a mismatch
  (which fails the test). Use a corpus from `tests/e2e/fixtures/diffs.js`
  (`evictionDiff`, `manyFilesDiff`, `edgeFilesDiff`: generated, with truthful
  contents the test server answers from a registry) and `routeDiff(page,
  corpus)`, which serves it in both modes. For verbatim `git diff` output a
  builder cannot produce, `customCorpus({ diff, files })` takes the contents
  alongside. An unregistered path still gets a generic 40-line pair from the
  test server; `E2E_CONTENTS_LOG=<file>` lists the paths that hit it (a full
  run: none).
- **"Upgraded" is not "displayed".** The upgraded diff is shown a worker round
  trip after the data says it is there, and every row of the file is re-created
  when it lands. Rows are re-created again whenever the file's annotations
  change (comments and suggestions arrive after the diff). Before measuring
  geometry or holding a row, `await waitForContentUpgrade(page, file)`
  (it waits for the display, not the data), and do not keep an element handle
  across an action that reloads comments. A locator re-resolves; a handle or a
  measured box does not.
- **Clean up strictly.** `cleanupAllComments(page, reviewId)` and
  `cleanupAISuggestions(page, reviewId)` check every response; `fetch` resolves
  on a 500, and a cleanup that fails silently makes a later, unrelated test
  fail. (`cleanupComments` is the best-effort variant for an `afterEach` on a
  page a failing test may have left mid-navigation.) Wait for a save you
  triggered before navigating away: a reload aborts it, the app logs the
  rejection, and the guard fails the test.
- **The context-files API is mocked in `context-files.spec.js`**, statefully,
  because the real POST route requires the file to exist in the review's
  working directory and the fixture reviews have none.
- **Assert the positive sentinel before the negative.** After a remount or any
  rebuild from data, assert the row that must still be there *first*; that is
  the proof the rebuild finished. Only then assert that the removed row is
  absent. Reversed, the absence check passes against a view that has not been
  rebuilt yet.

- **Point at a row only once the diff has settled.** After a load, each
  file's contents arrive and re-create its rows, and a file that grows moves
  every file below it. `hoverDiffLine`, `openCommentFormOnLine` and
  `openLineCommentForm` wait for `waitForDiffSettled` themselves; a spec that
  hovers or clicks a row on its own calls it (or `waitForContentUpgrade` for
  the file) first.
- **A pointer gesture whose target was replaced is made again, and only the
  gesture.** Rows are also re-created whenever a file's annotations change,
  and nothing signals the last of those after a load. `selectLineRange`,
  `clickExpandControl`, `openLineCommentForm` and the selection gestures of
  `text-selection.spec.js` wrap the gesture and the check of its result in
  one `expect(...).toPass()`; the final action of an attempt is the click
  itself, so it cannot happen twice. Do not retry an assertion about what
  the application did.
- **A behaviour the migration changes on purpose, or a defect main has, is
  asserted through a named constant in `diff-dom.js`** (`CONTEXT_FILE_PLACEMENT`,
  `LAYOUT_TOGGLE_KEEPS`, `UPGRADE_WAITS_FOR_FOCUS`,
  `DELETED_COMMENT_RETURNS_ON_RERENDER`, `CHAT_LINK_REACHES_UNRENDERED_FILE`,
  `REVEALED_LINE_KEEPS_FLASH`, `BASE_CHANGE_KEEPS_CARDS`,
  `THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY`,
  `GUTTER_BUTTON_STAYS_WITH_ANALYSIS_SUGGESTIONS`), with both outcomes
  written in the spec. The phase that changes the behaviour flips the
  constant; the spec is not edited. (Phase 3 flipped
  `DELETED_COMMENT_RETURNS_ON_RERENDER` and
  `THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY`.)
- **A card is asked for by what it is, never by where it is in the document.**
  The application resolves cards through `PRManager.findCommentCard`,
  `findSuggestionCard`, `ExternalCommentManager.findThreadCard` and
  `PierreBridge.getAnnotationElement`, which also know a card that is built
  and not attached. A lookup hands the card back as it is: only the engine's
  draw brings a built card in line with its data, so a flow that looks a card
  up and then updates it sees what the reader left (a test of such a flow
  draws with `bridge._renderAnnotation`, never by looking the card up). The
  diff pane's message is `diffStatus(page)` in
  `diff-dom.js` (the application shows it in `#diff-status`, a sibling of
  `#diff-container`, and nothing writes markup into `#diff-container`).
- **"Settled" includes the highlight worker pool.** A file that rendered
  before the pool was ready is rebuilt from scratch a frame after the pool
  reports ready: new rows, and every range the application revealed applied
  again. Alone that happens within 40 ms of the first rows; in a full run it
  can happen hundreds of milliseconds into a test. `waitForContentUpgrade`,
  `waitForFileSettled` and `waitForDiffSettled` wait for it, and the two
  helpers that change what a file displays by hand (`redisplayBaseDiff`,
  `expandHunkBy`) wait themselves: a manual expansion lives in the vendor
  instance on the current engine and is lost with it at the rebuild. A spec
  that holds a row does so only after one of the waits.
- **When two answers race, the test decides the order.** Two requests the
  application makes independently (a diff's file contents and a list of
  threads; a comment reload and a save) arrive in either order, and a
  scenario that leaves the order to chance asserts one of two behaviours at
  random. Hold one answer until the state the scenario is about has been
  reached (`mockExternalComments(...).holdLists()`, a gated `page.route`),
  assert that state, then release. Say in the test which order it pins and
  why. A race does not need a second action to exist: one ordinary page load
  already has the diff, each file's contents, the worker's highlight results,
  the comments, the suggestions and the external threads arriving
  independently. A scenario that asserts where an external thread is drawn
  holds the thread list until `waitForDiffSettled` (on main a list answered
  while a file's upgraded diff awaits display demotes that file's thread to
  its comment zone, 3 of 120 plain loads at eight workers;
  `rerender-overlays.spec.js` holds that window open and asserts it).
- **Assert the element the action was about, by name.** "The second
  `[data-file-name]` on the page" is whatever the page puts second (it was
  the first file's comment zone, not the second file). Locate a file by its
  path (`fileWrapper(page, 'src/utils.js')`, `headerLanding(page, path)`), a
  card by its id, a sidebar entry by `data-path`. And an assertion about
  where a scroll ended is made about the end: poll for the settled landing
  (`headerLanding`, `scrollState`), never `toBeInViewport` on something that
  was in the viewport before the scroll started.
- **Never click a point of something taller than the viewport.** A click
  that misses once ("element is not stable" while a panel settles) is
  retried by Playwright with forced scroll alignments of the target: end,
  centre, start. On `#diff-container` with the eviction or many-files corpus
  (tens of thousands of pixels) each of those puts the point off screen or
  under the pinned toolbar, so after one transient miss the click can never
  succeed and the test spends its whole timeout. To give the page keyboard
  focus on the diff side, click a small fixed element
  (`page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } })`).
- **Optional features are switched on through the server's own config
  answer**: `mockAppConfig(page, { summaries: { enabled: true } })` replaces
  the named keys of `GET /api/config` and nothing else. `mockHunkSummaries`,
  `mockTour` and `mockExternalComments` stand in for endpoints the test
  server does not mount; a server push is the DOM event the WebSocket client
  dispatches for it (`pushHunkSummaries`, `review:context_files_changed`).
- **Seed real rows.** `seedComment` and `seedSuggestions` write through the
  API and the test server, on any file and line of a routed corpus. A
  suggestion that exists only in a routed response cannot be adopted (the
  adopted comment's `parent_id` is a foreign key).
- **A comment on a file of a routed diff leaves a context file on the
  server** (the server does not find that file in the review's stored diff;
  in Local mode that is every comment, because the fixture review has no
  stored diff the route can read). `cleanupAllComments` removes context files
  too, through `page.request`, so a routed context-files API cannot hide
  them. In a `beforeEach` that runs after the page has loaded, also have the
  page load comments and suggestions again, or it still shows what it drew.
- **What a test draws on the two fixture reviews does not outlive it.** The
  fixture (`fixtureReviewsLeftClean` in `tests/e2e/fixtures.js`) retires
  every user comment, deletes every AI suggestion and analysis run, and
  removes every context file of reviews 1 and 2 after every test, once the
  page is closed, and fails the test if rows remain. A worker's database is
  shared by whichever spec files Playwright gives that worker, so anything
  left on a fixture review is drawn by an unrelated spec's next page load,
  differently in every run. A describe's own `afterEach` cleanup is therefore
  not what isolation rests on (one was lost in a rewrite and nothing noticed;
  a census found thirteen describes leaving comments and fourteen leaving
  suggestions). The suite's old "known flake", a gutter button left showing,
  was a test for a clean review meeting an analysis an earlier spec had left
  (ledger H66 of `plans/codeview-virtualized-diff.md`). A spec still cleans up, itself, whatever
  else it creates: another review, a setting, viewed state it did not mock,
  `localStorage`. And a test must not count on rows an earlier test left.
- **A spec does not know how the diff is drawn.** `tests/e2e/diff-dom.js` is
  the surface; what has to know the viewer from the inside (a file may not
  be mounted, the bridge's records, a context file's rows) is in its half,
  `diff-dom-codeview.js`, exported under the same names. During the
  migration to the virtualized viewer (`plans/codeview-virtualized-diff.md`)
  the whole suite ran unchanged on the renderer it replaced and on the
  viewer; that only worked because no spec named vendor DOM. Where the
  application has a behaviour a spec should not spell out (a defect kept as
  it is, the wording of a vendor label), the spec asks a named expectation
  of `diff-dom.js` (`contextGapLabel`, `expectedContextRanges`,
  `BASE_CHANGE_KEEPS_CARDS`, `SUGGESTION_BLOCK_HAS_EMPTY_LINE`, ...).
- **"The file has an element" is not "the file is in the pane".** The
  virtualized viewer has an element only for files near the viewport: two
  files down in a four-file pane there may be none. Never assert a file's
  presence through a locator's count or visibility: ask `filesInPane`,
  `expectContextFile`, `expectNoContextFile`. A helper that reads a file's
  rows brings the file into view first; a spec that points at a file further
  down scrolls to it (`scrollFileIntoView`). `waitForContentUpgrade(file)`
  returns for a file that rests outside the mounted window: its contents are
  fetched when it is drawn.
- **A long file is drawn a window of rows at a time.** A separator or a row
  that is far inside a long file may not be in the DOM. The context-file
  helpers take ranges and gaps from the application's data and check
  whatever is drawn against it; do not count rows of a long file in a spec.
- **Scroll through the helpers** (`scrollDiffTo`, `scrollDiffToEdge`,
  `scrollThroughDiff`, `scrollFileOutOfView`), never by setting `scrollTop`
  on an element a spec names. Which element scrolls is the adapter's to
  know, and the virtualized viewer holds a navigation's scroll
  target until the reader takes over: a position written by a script right
  after a sidebar jump is undone. The helpers let go the way a wheel does.
- **`test.use({ expectedConsoleErrors: [a, b] })` with two patterns is read
  by Playwright as `[value, options]`.** Pass one pattern with an
  alternation.
- **A development-bundle run** (`PR_VENDOR_BUNDLE=dev`)
  serves the vendor's development bundle and gives the viewer its layout
  validator: a layout that does not match what is drawn is a `console.error`
  and fails the test, and after every test one more pass with the pane at
  rest must be silent. `fixture-isolation.spec.js` asserts in every run that
  the bundle and the validator are what the run asked for. Every test also
  ends with the orphan-host check.
- **A change is checked with the whole suite, not with the specs it seems to
  touch.** A later change can take away what an earlier one had, and a run
  of the later change's own specs does not see it (during the migration,
  phase 6's CSS failed a test of phase 5's list that phase 6's list did not
  contain).
- **`scrollWidth - clientWidth` is a scroll range only on a box that
  scrolls.** On a box with `overflow: visible` it says how far something
  sticks out of the padding box, which includes anything drawn over the
  box's own border on purpose. `wrapInfo` (`diff-dom.js`) asks each box the
  question that fits it, and a test next to its user proves it still reads a
  line that does not wrap, in a column that scrolls and in one that does
  not. A measure of "nothing overflows" needs such a test: a 0 from a measure
  that cannot read anything else proves nothing.
- **A test of a click that must survive a redraw presses, redraws and
  releases** (`page.mouse.down()`, `redrawFile`, `page.mouse.up()`), on the
  application's own control. `locator.click()` cannot place a draw between
  the press and the release, and a stand-in control does not get its
  contents rewritten the way the application's header does on every draw.
- **Such a test is made with each kind of pointer, and counts the clicks.**
  A browser makes the click of a mouse press and the click of a tap in two
  ways: a mouse press (and a pen it reports as one) loses its click when the
  pressed element left the document before the release; a tap is recognized
  after the release and clicks what is under the point then, a few
  milliseconds after `pointerup`. Code that adds a missing click for the
  first kind doubles the click of the second, and a doubled click on a
  toggle looks like no click. `gesture` in `file-controls.spec.js` makes a
  press with a mouse, a pen or a touch (the last two through the protocol's
  `Input.dispatchMouseEvent` with `pointerType: 'pen'` and
  `Input.dispatchTouchEvent`; a touch needs `test.use({ hasTouch: true })`).
  The tap under test is not the first of the page: the first tap after a
  load gets its click in the task of the release, later ones do not. "One
  click, not two" is asserted with a sentinel, not a wait: a second gesture
  of the same kind on an element of the test's own, then a timer once its
  click has arrived (`clicksOfPressDrawRelease`).

- **"This click goes nowhere" is asserted with a sentinel too.** Two frames
  without a scroll prove nothing: navigation scrolls smoothly and starts a
  frame or more after the click. Make the same kind of click on something
  that does go somewhere, wait for the page to ask for that scroll
  (`watchScrollRequests` / `scrollRequests` in `diff-dom.js`: every
  `scrollIntoView` on an element of the pane and every scroll target given to
  the virtualized viewer, by the file it is for), and assert that nothing was
  asked for before it (N5 "has a sidebar entry and nothing in the pane").
- **"It stayed on screen throughout" is asserted frame by frame.** A read
  before and a read after cannot see a line that left the screen for a few
  frames and came back, which is what a re-render that waits for the
  highlighter looks like. Start a watch in the page before the action
  (`watchContextLines` in `diff-dom.js`, or a `requestAnimationFrame` loop in
  a contract test), wait for the end state by its own signal, end the watch
  (`contextLinesWatched` ends it after one more frame, so at least one frame
  is always seen) and assert that no frame lacked the rows (N5 "a range added
  to a file after the reader expanded a gap in it ...").
- **"In the document" is not "on screen" on the virtualized viewer.** A file
  of 5,000 rows or more has rows for a window of its lines, and the card of a
  line outside it is connected with no box. A test that proves a navigation
  arrived asserts `toBeInViewport()` on the card, never `toBeAttached()` or a
  count; a test of such a file needs more than 5,000 rows for a target the
  reader's window does not cover, and more than 10,000 for a file whose top
  is not drawn while the reader is at its end (N11 "Navigation to a card far
  down a file longer than the rows the viewer draws").
- **A pane scrolled to its end is not at its end a frame later when a card
  below got its height.** The card of a line the viewer has not drawn yet
  has no measured height; the pane grows by it after the scroll that drew the
  row. Do what a reader does: scroll to the end again until the pane rests
  there, with `expect(async () => { ... }).toPass()` around the scroll, the
  `scrollState` check and the assertions on what must be in the viewport
  (N11 "The last rows of a file a few rows longer than one block of the
  viewer's rows ..."). Never one `scrollDiffToEdge` followed by
  `toBeInViewport()` on the last line of a file that has cards.
- **Two navigations can start from one key press.** The review panel and the
  suggestion navigator both answer `j` and `k`, each with its own cursor, so
  a test that presses a key and expects one card in view depends on which of
  the two wins. On both engines it is the one that started last
  (`PRManager.revealInDiff`); a test must not assume the other's target was
  never asked for.

## Vendor contract suite (`tests/contract`)

- **The real vendor in a real browser is the only arbiter of what the vendor
  does.** `pnpm run test:contract` loads the built `@pierre/diffs` bundle into
  headless Chromium with no application server (requests to a virtual origin are
  fulfilled from disk; no port is bound, so it may run next to an E2E run). There
  is no hand-written model of `CodeView` anywhere in this repository, and none
  may be added.
- **A unit test may assert what we send to the vendor, never what the vendor
  does.** A jsdom test with a recording stub can check that K annotations become
  one `updateItem` with a bumped version. It cannot check that a card appears, a
  height is measured or a callback fires: a stub that "renders" encodes our
  belief about the vendor, and stays green when the vendor changes. The
  previous CodeView attempt had 181 such tests pass against a bridge that
  rendered zero annotations on the real component.
- **A module that talks to the bridge is unit-tested against the real bridge
  without the vendor, not against a bridge that draws.**
  `tests/utils/pierre-bridge-harness.js` builds the production `PierreBridge`
  with file records whose vendor instance is a spy: the annotation list, the
  visibility oracle (`isLineVisible`, from the hunks a test gives a file) and
  the element cache (`getAnnotationElement`) are real, and nothing is ever
  attached to the document. That is the point: `ExternalCommentManager`,
  `TourRenderer` and the page's card resolvers must decide from data, and a
  test that needs a card to appear in the document to pass is testing a
  belief about the vendor. The fake bridges that "slotted" a `<div>` on
  `addAnnotation` were removed for that reason (they kept the external-thread
  demotion of ledger H60 green).
- **A module that navigates or resolves elements through the page is
  unit-tested against the production `PRManager` methods.**
  `tests/utils/page-manager.js` gives a `PRManager` without running its
  constructor; a test stubs only what reaches outside the unit (the lazy body
  render, the line reveal, the file-element lookup). `revealInDiff`,
  `setFileCollapsed`, `findCommentCard` and the zone resolvers are never
  re-implemented in a test.
- **Every contract test names what depends on it** (a comment naming the bridge
  function), and a test that pins a vendor *bug* says so in its title. When one
  of those fails after a version bump, the bug may be fixed: re-read the fact
  before changing application code.
- **Any `console.error` fails a contract test**, including the development
  bundle's height validator. A spec that provokes one on purpose declares it
  with `harness.allowErrors(page, pattern)`.
- **Timings are recorded, never asserted.** `harness.record(name, data)` attaches
  a measurement to the test and, with `CONTRACT_EVIDENCE_DIR` set, writes it to
  disk. Assert structure instead: "at least one frame passed", "the card
  arrived together with the new diff".
- **The CodeView bridge is tested in the browser against the real vendor**
  (`tests/contract/bridge`, the same command). `openBridge(harness)` from
  `bridge-test.js` loads the development bundle, the production
  `PierreBridge` with the modules it depends on, and the app's own CSS
  for the gutter buttons; `window.BH` (`bridge-page.js`) builds entries from
  the workload and constructs the bridge the way the app does. A spec drives
  the bridge's public API and asserts the DOM and the bridge's data; it ends
  with `BH.sound()` (no orphan host, an exact layout), and the height
  validator is on for every test. No `pr.js` is loaded: what the page does
  with the bridge is E2E's subject.
- **Bridge behaviour that depends on being inside a viewer callback is tested
  from inside one**, in the browser: `BH.fromViewerCallback('hook' | 'renderer',
  file, line, fn)` runs `fn` from the page's lifecycle hook or from a card
  renderer during a real render pass. Such a test asserts both moments, the
  same task and after the pass (`await Promise.resolve()`, then `H.settle`),
  and compares the viewer's list with the bridge's records through
  `BH.listState(ids)` (`outOfStep` empty) and `BH.spyOnSetItems()` (how many
  list writes reached the real instance). Calling a viewer callback by hand on
  the unit stub proves what the bridge sends, never that the vendor accepts it.
  What the bridge sends to the viewer's list is read through
  `BH.spyOnListCommands()` (every `scrollTo` and `setSelectedLines` on the real
  instance, with whether the viewer had the item and the item showed the line
  at that moment), and what it asks of the page through the hooks themselves
  and `BH.rendererCalls`. A scenario that is one order of events among several
  (a hook asking during a write's flush, a command sent from a hook) is run
  twice, next to its control (the same calls made directly, one after the
  other), and must end where the control ends: same file, same pixel, same
  selection.
- **What a publish guarantees, and what it does not.** After an
  annotation-only publish on a file that is mounted, expanded, with no new
  diff awaiting display and with the worker pool ready, the card is connected
  in the same task. In every other state it is not: an unmounted or collapsed
  file draws nothing, a file whose new diff is still being highlighted goes on
  showing the old one with the cards it had, and nothing is mounted before the
  pool is ready. And the viewer attaches the wrapper of an annotation whose
  line it does not draw, with no height. So a test (and the application) may
  never read "the card is not in the document" as "the line is not shown", nor
  "the card is connected" as "the card is on screen": ask
  `bridge.isLineVisible` for the line and `bridge.getAnnotationElement` for
  the card, and use auto-waiting assertions for what reaches the screen.
- **A unit test of the CodeView bridge uses the recording stub of
  `tests/utils/pierre-bridge-harness.js`** in place of the viewer: it stores
  what the bridge sends and answers booleans and items. It never renders,
  mounts or calls a render callback, so such a test covers the bridge's own
  decisions only (records, derived metadata and their keys, the visibility
  oracle, the flush state machine, which records a reconcile keeps and when it
  writes the list). The metadata it works on comes from the installed
  package's own parsers.
- **The contract suite gates every `@pierre/diffs` bump.** The dependency is
  pinned to an exact version; `tests/unit/vendor-bundle-fresh.test.js` fails
  when the served bundle was not rebuilt after an install.

## How the diff pane looks (`tests/parity/visual.mjs`)

- **"The app's real CSS" means every stylesheet the pages load, in their
  order.** `pr.html` and `local.html` load `styles.css` after `pr.css`, and
  its `!important` rules change the file header's padding and border. A gate
  that loaded `pr.css` alone measured a 45 px header where the application's
  is 53 px, and a token was set from it. Gates take their stylesheets from
  `appStylesheets()` (`tests/contract/harness/constants.js`), which reads the
  two pages.
- **A change to how the diff pane is drawn is checked with
  `node tests/parity/visual.mjs --out <dir>`.** It opens both diff engines on
  one test server with the file contents held back, and compares every
  changed file as numbers (header box and its parts, distance to the first
  row, frame, space to the next file, gutter, row height, fonts) and the pane
  as pixels at fixed positions (top, a pinned header, the end, a collapsed
  file, during a tour). A difference that is not listed in its `ACCEPTED`
  with the decision that covers it fails the run. Do not run it while the E2E
  suite is running.
- **Pixels are compared with a tolerance for anti-aliasing only**: a pixel
  counts when it is outside the range of the 3x3 pixels around the same place
  in the other image by more than 8 of 255. The same glyph or curve painted in
  another compositing layer differs by less; a missing line, another colour or
  a shift of two pixels does not. Positions are compared as numbers, to a
  hundredth of a pixel, so a shift cannot hide in the tolerance.
- **Height that the virtualized viewer is not told about moves every file
  below it.** A border, padding or margin on the scroll container or on a
  file's element is such height. What draws the pane's box and a file's frame
  there, and which number tells the viewer, is in `pr.css` (the block for the
  viewer) and `pierre-styles.js` (`FRAME_CSS`); gates G9 and G13
  (`tests/contract/gates`) and `tests/unit/pierre-shared-modules.test.js` pin
  them.
- **A box is measured after the animations on it have ended.** A card slides
  in when it is attached (`slideUp`, 0.3 s, a transform), so its box is up to
  a tenth of a pixel away from its place for a few frames, and differently in
  every run. `visual.mjs` waits for every finite animation of the document
  before it measures cards; anything else that compares boxes to a fraction
  of a pixel must do the same.
- **A difference a single column wide can be inside the pixel tolerance.** A
  2 px ring painted over a 1 px border blends to a value between its two
  neighbours and passes; the same ring one pixel past the file's edge does
  not. When a position differs in one layout, look at the same place in the
  other layout before deciding it is that layout's alone.

## Cleanup

- Every resource a test creates (server, socket, temp dir, patched global,
  fake timers) must be released on the **failure** path too: `try/finally`
  or afterEach, never only at the end of the happy path.
- **Naming trap:** the root `.gitignore` ignores `test-*.js`. A helper named
  `tests/utils/test-server.js` will pass locally and silently not exist on
  CI. Name shared helpers accordingly (hence `loopback-server.js`).
