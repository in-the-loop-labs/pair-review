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

- **A pending `page.waitForResponse` / `waitForRequest` kills the whole worker.**
  Both are registered *before* the action that triggers them, so there is always
  a window before the `await`. If anything in that window fails — a click that
  times out, a failed assertion, the test deadline — the still-pending promise
  rejects unhandled, which does not merely fail the test: Playwright reports
  `worker process exited unexpectedly (code=1)` and every remaining test in that
  file fails at 0ms, so the run's failure set reshuffles by which worker died.
  Use `expectResponse` / `expectRequest` from `tests/e2e/helpers.js` — they
  attach the no-op catch and return the same promise, so awaiting it still
  reports a genuinely missing response.
- **The E2E file-contents endpoint answers for ANY path.**
  `tests/e2e/test-server.js` serves `src/utils.js` verbatim and falls back to a
  generic 40-line body for every other file name. So the idle content upgrade
  fires for every non-binary file in a mocked diff and re-renders it — a
  300-line patch *shrinks* to 40 lines. Any test that measures geometry (scroll
  extent, item tops, element positions) must first wait for the upgrade to land
  (`pierreBridge.files.get(file).baseMetadata` is set) **and** for the extent to
  settle. Measuring across the upgrade reports churn as signal: it has produced
  both a phantom 314px "wandering gap" and a phantom 218px "the layout absorbed
  the form".
- **Assert the positive sentinel before the negative.** After an evict/remount
  or any rebuild-from-data, assert the row that must still be there *first* —
  that is the proof the rebuild finished — and only then that the removed row is
  absent. Reversed, the absence check passes against a host that has not
  rebuilt yet. `whenAnnotationsSlotted` is a bounded best-effort, not a barrier,
  so pair it with a generous Playwright assertion rather than trusting it alone.

## Cleanup

- Every resource a test creates (server, socket, temp dir, patched global,
  fake timers) must be released on the **failure** path too: `try/finally`
  or afterEach, never only at the end of the happy path.
- **Naming trap:** the root `.gitignore` ignores `test-*.js`. A helper named
  `tests/utils/test-server.js` will pass locally and silently not exist on
  CI. Name shared helpers accordingly (hence `loopback-server.js`).
