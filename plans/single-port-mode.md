# Single-Port Mode

## Context

pair-review currently picks the next available port when its configured port is busy (`findAvailablePort` tries up to 20 sequential ports). This creates unpredictable ports that break bookmarks, MCP configs, and user expectations. Multiple servers can also contend on the same SQLite database.

**Goal**: By default, pair-review uses one port. A second invocation delegates to the running server by opening the appropriate URL in the browser, then exits. A config escape hatch (`single_port: false`) preserves the current multi-server behavior for development.

Additionally, when a newer version invokes an older running server, the server notifies the user that an update is available.

---

## Startup Flow (single_port: true)

```
pair-review <args>
  │
  ├─ Early exits (--mcp, --help, --version, --configure, --register) → unchanged
  │
  ├─ Load config, parseArgs
  │
  ├─ Headless mode (--ai-review, --ai-draft)? → skip single-port, proceed normally
  │
  ├─ config.single_port === false? → skip single-port, proceed normally
  │
  ├─ GET http://localhost:{port}/health (2s timeout)
  │   │
  │   ├─ ECONNREFUSED → no server running
  │   │   └─ Start server on exact port (no fallback). EADDRINUSE = hard fail.
  │   │
  │   ├─ Response has service: 'pair-review'
  │   │   ├─ Construct URL for mode (PR / local / landing page)
  │   │   ├─ If our version > server version → POST /api/notify-update
  │   │   ├─ Open browser to URL
  │   │   └─ exit(0)
  │   │
  │   └─ Response without service: 'pair-review' (or non-JSON)
  │       └─ Hard fail: "Port {port} is in use by another service"
  │
```

---

## Changes

### 1. Add `single_port` to config defaults
**File**: `src/config.js`
- Add `single_port: true` to `DEFAULT_CONFIG` (after `port`)

### 2. Create `src/single-port.js` — detection and delegation
New module with three exports, using the `_deps` injection pattern from `src/protocol-handler.js`:

**`detectRunningServer(port, _deps)`**
- Uses Node `http.get` to hit `http://localhost:{port}/health` with 2s timeout
- Returns `{ running: false }` on ECONNREFUSED/timeout
- Returns `{ running: true, isPairReview: true, version }` if response has `service: 'pair-review'`
- Returns `{ running: true, isPairReview: false }` otherwise

**`notifyVersion(port, currentVersion, _deps)`**
- POST to `http://localhost:{port}/api/notify-update` with `{ version: currentVersion }`
- Fire-and-forget (don't block on response)

**`buildDelegationUrl(port, mode, context)`**
- `mode: 'pr'` → `http://localhost:{port}/pr/{owner}/{repo}/{number}[?analyze=true]`
- `mode: 'local'` → `http://localhost:{port}/local?path={encodeURIComponent(path)}[&analyze=true]`
- `mode: 'server'` → `http://localhost:{port}/`
- Returns the URL string

### 3. Restructure `main()` in `src/main.js`
The detection must happen **after** parseArgs (to know the mode) but **before** initializeDatabase (delegating process should not touch the DB).

**Move up**: `parseArgs()` call and flag processing currently at line 454. Move to immediately after `loadConfig()` (line 435). `parseArgs` is pure — no DB or config dependency.

**Insert single-port block** between parseArgs and DB init:
```
if (config.single_port !== false && !flags.aiReview && !flags.aiDraft) {
  const result = await detectRunningServer(config.port);
  if (result.running && result.isPairReview) {
    // Construct URL based on mode
    // - PR args present: parse with PRArgumentParser, build /pr/... URL
    // - flags.local: build /local?path=... URL  
    // - no args: build / URL
    // Notify version if ours is newer (semver comparison)
    // Open browser
    // exit(0)
  }
  if (result.running && !result.isPairReview) {
    throw new Error(`Port ${config.port} is in use by another service. ...`);
  }
  // Not running — proceed to start server normally
}
```

**PR argument parsing for delegation**: Use `PRArgumentParser` to extract owner/repo/number. `parsePRUrl()` is synchronous for URL inputs. `parsePRArguments()` (async, reads git remote) needed for bare PR numbers. Neither requires DB.

**Query params**: Pass `?analyze=true` when `flags.ai` is set. For local mode, also pass `&analyze=true`.

### 4. Bypass `findAvailablePort` when single_port is true
**File**: `src/server.js`

In `startServer()`, after the port is determined (~line 368):
```js
let port;
if (config.single_port !== false) {
  port = config.port;
  // Listen directly — EADDRINUSE is a hard failure
} else {
  port = await findAvailablePort(app, config.port);
}
```

When single_port is true and `EADDRINUSE` fires on `app.listen()`, improve the error message:
"Port {port} is already in use. A pair-review server may already be running, or another service is using this port."

### 5. Enhance `/health` endpoint
**File**: `src/server.js` (~line 298)

```js
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pair-review',
    version: require('../package.json').version,
    timestamp: new Date().toISOString()
  });
});
```

### 6. Version notification endpoint + in-memory state
**File**: `src/routes/config.js`

**Module-level state** — a plain string, not an object. Monotonically increases
for the life of the process:
```js
let pendingUpdateVersion = null;
```

**New endpoint**: `POST /api/notify-update`
- Accepts `{ version }`
- 400 if invalid semver
- Compares with own version via `semver.gt(req.body.version, version)`; if not
  strictly newer → `{ notified: false, reason: 'not_newer' }`
- If `pendingUpdateVersion` is already set and incoming is not strictly newer
  than it → `{ notified: false, reason: 'not_newer_than_pending' }`
- Otherwise: `pendingUpdateVersion = incomingVersion`, log, return
  `{ ok: true, notified: true }`

**Version-based suppression, not time-based.** There is no 24h timer. Three
cases are handled by version comparison alone:
- `incoming == pending`  → suppressed (nothing new to say)
- `incoming  > pending`  → accepted (genuinely newer)
- `incoming  < pending`  → suppressed (downgrade — user already knows)

This is clock-skew robust and makes tests deterministic (no fake timers).

**Augment `GET /api/config`** response:
- Add `pending_update: pendingUpdateVersion`

**Test-only export**: `module.exports._resetPendingUpdate = () => { pendingUpdateVersion = null }`
— used by integration tests to reset module-level state between cases.

### 7. Frontend: UpdateBanner component
**New file**: `public/js/components/UpdateBanner.js`

A persistent, dismissible corner-card notification. Single delivery path —
fetch `/api/config` in the constructor and show the banner if `pending_update`
is set. No WebSocket coupling, no global `window._pairReviewConfig`, no event
listener on the window.

- Fetches `/api/config` in constructor (Promise chain, `.catch(() => {})`
  swallows network errors because the banner is non-critical)
- Shows: "pair-review v{version} is available. Restart the server to update."
- Positioned as a compact corner card: `top: 16px; left: 16px; max-width: 360px`,
  rounded corners, drop shadow matching the `.toast` aesthetic
- Dismiss button removes it; dismissal stored in `sessionStorage` keyed by
  version so a newer version re-shows
- Class declared at file scope (no IIFE) with `module.exports = { UpdateBanner }`
  for unit-test access, matching the convention of other components

### 8. Include UpdateBanner in HTML pages
**Files**: `public/pr.html`, `public/local.html`, `public/index.html`, `public/setup.html`

Add `<script src="/js/components/UpdateBanner.js"></script>` on every page that
should surface update notifications. Because the component fetches `/api/config`
itself, no wiring from page-specific JS is required.

### 9. Add `semver` as direct dependency
Currently available as transitive dep via `update-notifier`. Add explicitly for reliability:
```
npm install semver
```

---

## Hazards

**`main()` restructuring — parseArgs ordering**: Moving `parseArgs` before DB init changes the order of operations. `parseArgs` is pure (parses argv, returns flags/prArgs). No dependency on DB or pool. `applyConfigOverrides(config)` at line 474 also has no DB dependency. Safe to move both. Everything from `initializeDatabase` through `poolLifecycle.resetAndRehydrate` stays after the single-port check.

**`startServer()` called from 4 places**: `handlePullRequest`, `startServerOnly`, `handleLocalReview` (in local-review.js), and `performHeadlessReview`. The `findAvailablePort` bypass affects all four. MCP mode starts server via `startMCPStdio` (line 329) — handled before single-port check, so unaffected. Headless modes bypass single-port detection but still call `startServer`; when `single_port: true`, they'll bind to the exact port. This is intentional — headless modes typically run in CI where no other server is running. If they DO conflict, the improved EADDRINUSE message guides the user.

**`handleLocalReview` has its own config + DB init**: `local-review.js:714-723` calls `loadConfig()` and `initializeDatabase()` independently. When delegating, `handleLocalReview` is never called. When NOT delegating (port is free), the normal flow calls it and its internal DB init is fine (same DB, same config).

**Local mode env vars and in-memory diffs**: `handleLocalReview` sets `PAIR_REVIEW_LOCAL_*` env vars and stores diff data in `localReviewDiffs` Map. When delegating, none of this happens — the existing server's web UI setup flow (via `POST /api/local/start` in `src/routes/local.js`) handles diff generation server-side.

**TOCTOU race**: Between health check confirming port is free and `app.listen()`, another process could grab the port. Window is <1s. Mitigated by clear EADDRINUSE error message. Not worth a retry mechanism.

**Pull-only update delivery**: Update notifications are delivered exclusively via `GET /api/config` — there is no WebSocket push path. An already-open tab will not see a new banner the instant `POST /api/notify-update` fires; the banner appears on next page load or new tab. For a "restart to update" notification this tradeoff is correct — restart is disruptive, so instant delivery has no meaningful value over next-page-load delivery, and the single code path is much simpler to reason about and test.

**`pendingUpdateVersion` is in-memory, monotonic**: Resets on server restart. Correct — a restart either IS the update (running version is now newer) or loses no information (the next notifier re-populates it). Only ever increases during a process's lifetime, so downgrades are impossible by construction.

---

## Verification

1. **Unit tests** (`tests/unit/single-port.test.js`):
   - `detectRunningServer`: mock HTTP responses for each case (ECONNREFUSED, pair-review response, non-pair-review response, timeout)
   - `buildDelegationUrl`: all mode/flag combinations
   - `notifyVersion`: verify POST body and fire-and-forget behavior
   - Version comparison edge cases (same version, older, newer, pre-release)

2. **Integration tests** (`tests/integration/routes.test.js`):
   - `GET /health` returns `service: 'pair-review'` and `version`
   - `POST /api/notify-update`: 400 on invalid/missing/empty version
   - `POST /api/notify-update`: `{ notified: false, reason: 'not_newer' }` when version ≤ running
   - `POST /api/notify-update`: newer version is accepted and visible via `GET /api/config` `pending_update`
   - Version-aware suppression: same version suppressed, strictly-newer accepted, downgrade suppressed (monotonic `pendingUpdateVersion`)
   - Use the `_resetPendingUpdate()` test helper exported from `src/routes/config.js` in `beforeEach` to isolate module-level state

3. **Manual E2E**:
   - Start `pair-review` (server starts on 7247)
   - Run `pair-review https://github.com/owner/repo/pull/123` — should open URL on existing server and exit
   - Run `pair-review --local` — should open local URL on existing server and exit
   - Run `pair-review` with no args — should open landing page on existing server and exit
   - Kill server, run again — should start fresh
   - Set `single_port: false` in config — should use port fallback behavior
   - Modify package.json version to simulate newer, run against older server — verify update banner appears

4. **E2E tests**: Update existing E2E tests if any exercise server startup or port behavior
