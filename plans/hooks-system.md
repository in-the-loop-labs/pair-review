# Hooks System

## Context

Add a hooks system to pair-review so users can run external commands on lifecycle events (e.g., telemetry, commit trailers, notifications) without modifying the codebase. Commands receive JSON on stdin. Multiple named hooks per event. Fire-and-forget, with stdout/stderr piped to logger. User-level config only (`~/.pair-review/config.json`) — no project-level hooks for security.

## Config format

Named hooks (objects, not arrays) for clean config merging:

```json
{
  "hooks": {
    "review.started": {
      "record_started": { "command": "my-telemetry review-started" }
    },
    "analysis.completed": {
      "record_done": { "command": "my-telemetry analysis-done" },
      "annotate_commit": { "command": "my-trailer-tool" }
    }
  }
}
```

Override with empty object to disable: `"record_started": {}`

## Events & payloads

**review.started** / **review.loaded** — new vs returning session:
```json
{
  "event": "review.started",
  "timestamp": "ISO8601",
  "reviewId": 42,
  "mode": "pr",
  "user": { "login": "..." },
  "pr": { "number": 364, "owner": "...", "repo": "...", "author": "...", "baseBranch": "...", "headBranch": "...", "baseSha": "...", "headSha": "..." }
}
```
Local mode: `"local": { "path": "...", "branch": "...", "scope": "...", "headSha": "..." }` instead of `"pr"`. User optional.

**analysis.started**:
```json
{
  "event": "analysis.started",
  "timestamp": "...",
  "reviewId": 42,
  "analysisId": "uuid",
  "provider": "claude",
  "model": "opus",
  "mode": "pr",
  "pr": { ... },
  "user": { "login": "..." }
}
```

**analysis.completed** (fires on success, failure, and cancellation):
```json
{
  "event": "analysis.completed",
  "timestamp": "...",
  "reviewId": 42,
  "analysisId": "uuid",
  "provider": "claude",
  "model": "opus",
  "status": "success",
  "totalSuggestions": 7,
  "mode": "pr",
  "pr": { ... },
  "user": { "login": "..." }
}
```
Status values: `"success"`, `"failed"`, `"cancelled"`.

---

## Implementation

### `src/hooks/hook-runner.js`

Core engine. Iterates `Object.entries(config.hooks[eventName])`, spawns each named hook's command. stdio is `['pipe', 'pipe', 'pipe']` — stdout → `logger.debug`, stderr → `logger.warn`. 5s timeout → `SIGTERM`. DI via `_deps`.

### `src/hooks/payloads.js`

Pure payload builders with shared `buildContextFields()` for mode/pr/local/user. Exports:
- `buildReviewStartedPayload`, `buildReviewLoadedPayload`
- `buildAnalysisStartedPayload`, `buildAnalysisCompletedPayload`
- `getCachedUser` (lazy, cached per server session), `_resetUserCache`

### Integration points

| Event | File | Location |
|-------|------|----------|
| review.started/loaded | `src/routes/pr.js` | GET endpoint — uses `getOrCreate` for eager review creation |
| review.started/loaded | `src/routes/local.js` | POST /api/local/start |
| analysis.started | `src/routes/pr.js`, `local.js`, `analyses.js` (council) | After broadcastReviewEvent |
| analysis.completed (success) | `src/routes/pr.js`, `local.js`, `analyses.js` (council, external import) | In .then() |
| analysis.completed (failed) | `src/routes/pr.js`, `local.js`, `analyses.js` (council) | In .catch() |
| analysis.completed (cancelled) | `src/routes/pr.js`, `local.js`, `analyses.js` (council, cancel endpoint) | In cancellation paths |

### Config

`src/config.js`: `hooks: {}` in DEFAULT_CONFIG.

## Verification

- Unit tests: 35 tests in `tests/unit/hook-runner.test.js` and `tests/unit/hook-payloads.test.js`
- Full suite: 5100 unit/integration tests passing
- E2E: 251 tests passing, 0 failures
