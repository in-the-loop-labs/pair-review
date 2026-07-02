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

## Cleanup

- Every resource a test creates (server, socket, temp dir, patched global,
  fake timers) must be released on the **failure** path too: `try/finally`
  or afterEach, never only at the end of the happy path.
- **Naming trap:** the root `.gitignore` ignores `test-*.js`. A helper named
  `tests/utils/test-server.js` will pass locally and silently not exist on
  CI. Name shared helpers accordingly (hence `loopback-server.js`).
