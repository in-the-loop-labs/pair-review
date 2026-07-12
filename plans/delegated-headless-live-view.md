# Delegated Headless: Live UI Viewing for CLI-Driven Reviews (pair-loop)

## Problem

The pair-loop skill drives reviews through `pair-review --headless --json`. That
path (`runHeadlessAnalysis`, `src/main.js:1798` → `src/councils/headless-council.js`)
is a deliberate "server-free twin": it records only coarse `analysis_runs` DB rows.
The web UI's live council view is fed entirely by the in-memory `activeAnalyses`
map + WebSocket broadcasts inside the server process (`src/routes/shared.js:25,214,322`).
Result: during a pair-loop run the UI either shows nothing or a synthetic
single-model "running" skeleton (`src/routes/reviews.js:899-918`) that never updates.

## Solution: server-delegated headless

When `--headless` detects a healthy, compatible pair-review server on
`config.port`, delegate analysis **execution** to the server (so the run
populates `activeAnalyses` and broadcasts WS progress exactly like a
button-click run) and have the CLI wait for completion, then emit the
**byte-identical** `--json` document via `buildHeadlessJson(db, runId, mode)`
(`src/main.js:2389`), which reads purely from the shared SQLite DB.

True headless (no server) remains fully supported and unchanged: no server,
version mismatch, DB-identity mismatch, or `--no-server` → today's in-process
path. New flag `--require-server` fails fast instead of falling back.

Benefits both directions: the human gets a real live council dialog; the agent
gains a progress window (`GET /api/analyses/:id/status`, echoed to stderr).

## Contracts (both halves code against these)

### 1. Health handshake
`GET /health` (`src/server.js:418`) additionally returns:
```json
{ "status": "ok", "service": "pair-review", "version": "<pkg>", "dbId": "<sha256 hex>", "timestamp": "..." }
```
`dbId` = `computeDbId(resolvedDbPath)` from `src/utils/db-identity.js`
(already created; exports `resolveDbPath(config)` and `computeDbId(dbPath)`).
CLI delegates only when `service === 'pair-review'` AND `version` equals the
CLI's own package.json version AND `dbId` equals `computeDbId(resolveDbPath(config))`
computed CLI-side. Anything else → in-process fallback (stderr note).

### 2. Setup (delegated mode)
- **Local**: `POST /api/setup/local` body `{ path, scope, base }`
  (`src/routes/setup.js:210`). MUST accept the same `--scope`/`--base` values
  the CLI accepts (default scope `unstaged..untracked`, `branch..untracked`
  with `--base`, etc. — same validation semantics as CLI `parseScopeArg` /
  `resolveScopeAndBase`). Extend the endpoint if any CLI-supported form is
  rejected. Returns `{ setupId }` (or short-circuit shape).
- **PR**: `POST /api/setup/pr/:owner/:repo/:number` body `{ host? }`
  (`src/routes/setup.js:55`). Idempotent; may short-circuit with
  `{ existing: true, reviewUrl }`. Server owns the worktree-pool hold —
  the delegating CLI must NOT acquire/release a pool slot.

### 3. Setup status polling (new endpoint, avoids WS race)
`GET /api/setup/:setupId/status` →
`{ status: 'running'|'complete'|'error', reviewUrl?, reviewId?, error?, progress? }`.
Backed by a small in-memory map written alongside the existing
`setup:{setupId}` WS pushes in `src/routes/setup.js` (entries expire ~30 min,
mirroring `activeAnalyses` cleanup). Unknown id → 404. The CLI polls this
instead of opening a WebSocket (no missed-event race, no WS client in CLI).

### 4. Analysis launch (existing endpoints, unchanged)
CLI resolves config locally via `resolveReviewConfig`/`resolveCouncilHandle`
(as today) and passes **resolved, explicit** values — the server never
re-resolves (repo convention: pass resolved values down):
- Local council: `POST /api/local/:reviewId/analyses/council`
  `{ councilId, customInstructions, configType, excludePrevious }` (`src/routes/local.js:2349`)
- Local single: `POST /api/local/:reviewId/analyses`
  `{ provider, model, tier, customInstructions, skipLevel3, enabledLevels, excludePrevious }` (`src/routes/local.js:1357`)
- PR equivalents under `/api/pr/:owner/:repo/:number/...` (`src/routes/pr.js:2374`)
All return `{ analysisId, runId, status: 'started' }` immediately.

### 5. Wait / emit
Poll `GET /api/analyses/:id/status` (`src/routes/analyses.js:353`) every ~3s;
optionally echo level/voice progress to stderr. Terminal when `status` is
`completed|failed|cancelled`, then confirm via the DB run row and emit with
the existing `buildHeadlessJson`/`emitHeadlessResult`. If the server becomes
unreachable (~5 consecutive poll failures) and the DB row is non-terminal,
emit `{ ok: false, error: ... }` explaining the server died mid-run (exit 1).
On SIGINT/SIGTERM: best-effort `POST /api/analyses/:id/cancel`, then exit.

## File ownership

- **Server half**: `src/server.js` (health), `src/routes/setup.js`
  (scope/base support + status map/endpoint), integration tests.
- **CLI half**: new `src/headless/delegate.js` (DI `defaults` + `_deps`
  pattern), `src/main.js` wiring + `--no-server`/`--require-server` flags,
  unit tests, README, `plugin-pair-loop/skills/loop/SKILL.md` liveness
  wording, changeset (minor).
- Shared (already landed): `src/utils/db-identity.js`, `resolveDbName`
  export in `src/config.js`.

## Hazards

- **Instruction parity**: in-process headless feeds instructions to the
  analyzer directly; delegated mode goes through the endpoints'
  `customInstructions` assembly. `src/ai/analyzer.js` has three independent
  instruction paths (`analyzeAllLevels`, `runReviewerCentricCouncil`,
  `runCouncilAnalysis`). Verify the merged instructions are equivalent in
  both headless variants or councils will review with different prompts
  depending on whether a server happened to be running.
- **`handleHeadlessAnalysis` finally-block** (`src/main.js:2363`) releases a
  PR pool slot. Delegated PR mode must never acquire one — the server-side
  setup owns the worktree. Releasing a slot the server is analyzing in
  would hand the worktree to another consumer mid-run.
- **`runHeadlessAnalysis` callers**: CLI startup is the only caller today —
  verify before reshaping its signature.
- **Server dies mid-run**: the `analysis_runs` row stays `running` forever;
  the CLI must not poll indefinitely (grace period + clear error).
- **Version/schema skew**: an older server would accept requests but run old
  code; exact-version match gates delegation. The existing
  `POST /api/notify-update` flow is unrelated — don't conflate.
- **Setup short-circuits**: PR setup may return `{ existing: true }` with no
  `setupId`; local setup may resume an existing review. The CLI must handle
  both shapes without polling a nonexistent setup.
- **mcp-stdio servers** run on auto-ports with no registry — only the
  `config.port` server is discoverable. Documented limitation.
- **Flag interactions**: `--scope`/`--base` are local-only; `--require-server`
  + no server → exit 1 with `{ ok:false }` in `--json` mode.
- **Config drift (accepted limitation)**: delegated runs use the server's
  startup `config.globalInstructions`; in-process runs read config fresh.
  Editing global instructions mid-session diverges the two until the server
  restarts. Consistent with the no-hot-reload principle; documented in README.
- **reviews.js DB fallback** (`src/routes/reviews.js:899-918`) still
  synthesizes a fake single-model status for mcp-stdio/post-restart cases —
  out of scope here; follow-up.
