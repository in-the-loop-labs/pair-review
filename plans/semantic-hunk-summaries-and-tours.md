# Plan: Semantic Hunk Summaries and Tours

## Context

Two new background-AI features hang off review load:

1. **Semantic Hunk Summaries** — per-file batched LLM call producing one short natural-language description per non-trivial hunk, displayed inline as info-blue annotations.
2. **Tours** — an ordered, narrative walkthrough of stops (file + hunk) generated *after* summaries are available, displayed as pale-yellow inline annotations + a sticky bottom tour bar.

Both reuse the existing one-shot Provider machinery, both share a new `summary_provider` / `summary_model` config concept, both must work in PR mode (`/pr/:owner/:repo/:number`) and Local mode (`/local/:reviewId`), and both must trigger from BOTH the CLI startup path and the web UI route handler.

Note: PR-mode route surface for review/comment work is `src/routes/pr.js` plus the shared `src/routes/analyses.js` (there is no `src/routes/comments.js`). PR/Local parity in this plan therefore means: `src/routes/local.js` + `src/local-review.js` (Local CLI/web) and `src/routes/pr.js` + the GET review-load handler (PR web).

---

## Phased Implementation

Each phase is independently testable, ships independently, and leaves the app in a working state.

### Phase 1 — Config + background-provider plumbing
- Extend `DEFAULT_CONFIG` in `src/config.js` with `summary_provider` and `summary_model` (resolution rules below).
- Add `getSummaryProvider(config)` / `getSummaryModel(config)` helpers next to `getDefaultProvider`/`getDefaultModel`.
- Update `config.example.json` to advertise the new keys.
- Unit tests for resolution + fallback behavior in `tests/unit/config.test.js`.
- No behavior change yet beyond making the values available.

### Phase 2 — Summary storage + migration
- Bump `CURRENT_SCHEMA_VERSION` from 44 → 45 in `src/database.js`.
- Add `hunk_summaries` table to `SCHEMA_SQL` and corresponding indexes to `INDEX_SQL`.
- Add migration 45 that creates the table + indexes idempotently (mirror existing migration patterns: column/table existence checks, exception-safe try/catch).
- Add `HunkSummaryRepository` to `src/database.js` with `getByReview(reviewId)`, `getByHashes(reviewId, hashes)`, `upsertMany(rows)`, `deleteByReview(reviewId)`.
- Update test schema mirrors:
  - `tests/e2e/global-setup.js`
  - `tests/integration/routes.test.js`
- Unit tests in `tests/unit/hunk-summary-repository.test.js` and `tests/integration/database.test.js` for migration idempotence.

### Phase 3 — Hash + trivial-hunk detection (pure-function libraries)
- New module `src/ai/hunk-hashing.js`:
  - `hashHunk(filePath, hunkContent)` → SHA-256(`${filePath}\n${hunkContent}`) hex (Node `crypto`, no deps).
  - `isTrivialHunk(hunk, filePath)` returning `{trivial: boolean, reason?: 'whitespace'|'imports'|'version_bump'|'generated'|'tiny'}`.
- Trivial-hunk heuristic — see "Trivial-hunk heuristic" section below.
- Unit tests in `tests/unit/hunk-hashing.test.js` covering whitespace, import-only changes, version bumps, real changes (negative cases), boundary cases.

### Phase 4 — Summary generation backend (trigger + queue + persist + broadcast)
- New module `src/ai/summary-generator.js` exporting `generateSummariesForReview({db, config, reviewId, hunksByFile, worktreePath, signal})`.
  - Splits hunks into trivial (skip + persist a sentinel summary so we don't re-enqueue) and non-trivial.
  - Hashes every non-trivial hunk; left-joins against `hunk_summaries` to find missing.
  - Per file with any missing hashes, enqueues a single batched LLM call.
  - Calls `createProvider(backgroundProvider, backgroundModel)` and uses `provider.execute(prompt)`.
  - Validates JSON via `extractJSON` (`src/utils/json-extractor.js`).
  - Persists results via `HunkSummaryRepository.upsertMany`.
  - As each file completes, calls `broadcastReviewEvent(reviewId, { type: 'review:hunk_summaries_ready', filePath, summaries: [...] })`.
- New in-process queue in `src/ai/background-queue.js`:
  - Singleton with bounded concurrency — hardcoded constant `BACKGROUND_QUEUE_CONCURRENCY = 2` (see "Resolved Decisions"; not configurable in v1).
  - `enqueue(reviewId, jobType, fn)` keyed so the same `(reviewId, jobType)` is deduped.
  - On job complete, fires `broadcastReviewEvent(reviewId, { type: 'review:background_job_finished', jobType })`.
- Trigger sites (parity required across all four):
  - `src/local-review.js` — after `setLocalReviewDiff`/`saveLocalDiff`, before `open()`.
  - `src/routes/local.js` `POST /api/local/start` — after diff is persisted.
  - `src/routes/local.js` `GET /api/local/:reviewId` — re-trigger if `hunk_summaries` rows are missing for current hashes.
  - `src/routes/pr.js` `GET /api/pr/:owner/:repo/:number` — after diff is loaded.
- Hunks parsed server-side at trigger time. Reuse existing diff-parsing helpers in `src/utils/diff-file-list.js` / `src/utils/diff-file-content.js`. If those don't expose hunk-level slicing, add `parseHunks(diffText)` in `src/utils/diff-hunks.js`.
- Tests:
  - Unit tests for `summary-generator` (mock provider via `_deps` injection pattern).
  - Unit tests for `background-queue` (concurrency, dedup, ordering).
  - Integration test in `tests/integration/local-sessions.test.js` and a new `tests/integration/pr-summaries.test.js`.

### Phase 5 — Summary UI
- New CSS section in `public/css/pr.css` for `.hunk-summary-annotation` with light + dark variants in info-blue.
- New module `public/js/modules/hunk-summary-renderer.js`:
  - `renderInline(hunkEl, summary)` injects an annotation row immediately following the hunk.
  - Includes a small dismiss "x" → fires `prManager.dismissHunkSummary(hash)` (per-hunk hide; persisted in `localStorage` keyed on `reviewId:hash`).
- Patch `public/js/pr.js` `PRManager`:
  - On render, fetch summaries via `GET /api/reviews/:reviewId/hunk-summaries` (new endpoint in `src/routes/analyses.js`, ID-based so it works for PR + Local).
  - Subscribe to `review:hunk_summaries_ready` via existing `wsClient`; on event, render in.
  - Add review-level toggle button to the main toolbar; file-level toggle to the file header.
- Patch `public/js/local.js` only if needed — verify `_initReviewEventListeners` registration covers both modes (per existing pattern).
- Tests:
  - Unit test for `hunk-summary-renderer.js`.
  - E2E test covering: load a review, summaries render after WS event, toggle hides them, dismiss hides one.

### Phase 6 — Tour storage
- Migration 46: add `tours` table.
  - Columns: `review_id INTEGER PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE`, `stops TEXT NOT NULL` (JSON array), `hash_set TEXT NOT NULL` (sorted JSON array of constituent hunk hashes), `provider TEXT`, `model TEXT`, `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`.
- Add `TourRepository` to `src/database.js` with `get(reviewId)`, `upsert(row)`, `deleteByReview(reviewId)`.
- Update test schema mirrors (e2e + integration).
- Tests for repository.

### Phase 7 — Tour generation backend
- New module `src/ai/tour-generator.js` exporting `generateTourForReview({db, config, reviewId, summaries, worktreePath})`.
  - Computes current `hashSet` from the summaries it receives.
  - If `tours.hash_set === currentHashSet`, no-op.
  - Otherwise, calls the provider with all summaries as input (NOT raw diff).
  - Validates output JSON shape; persists via `TourRepository.upsert`.
  - Broadcasts `broadcastReviewEvent(reviewId, { type: 'review:tour_ready' })`.
- Hook into the background-queue: when summary-job completion fires for a review, enqueue tour-generation.
- Trigger sites are the same four as Phase 4.
- Add ID-based GET `/api/reviews/:reviewId/tour` to `src/routes/analyses.js`.
- Tests: unit test for staleness detection; integration test for end-to-end (mock provider).

### Phase 8 — Tour UI
- New CSS section in `public/css/pr.css` for `.tour-annotation` (pale yellow), light + dark.
- New component `public/js/components/TourBar.js` — sticky bottom bar showing "Stop N of M" + Prev/Next/Exit + Restart/Close on completion.
- New module `public/js/modules/tour-renderer.js`:
  - `mountStop(hunkEl, stop)` injects the numbered annotation with title + description + Prev/Next.
  - `scrollToStop(stop)` centers the target hunk into view.
  - `setActive(true|false)` toggles tour mode (auto-hides summary annotations via CSS class on `<body>`; restores on exit).
- Patch `public/js/pr.js`:
  - "Start Tour" button in main toolbar (calls `GET /api/reviews/:reviewId/tour`, opens tour mode).
  - Subscribe to `review:tour_ready`.
  - Keyboard shortcuts (Left/Right/Esc) when tour active.
- Tests: unit tests for TourBar / tour-renderer; E2E covering full happy-path + keyboard nav + completion state.

---

## File-by-File Inventory

### Backend (new)
- `src/ai/hunk-hashing.js` — pure functions: `hashHunk`, `isTrivialHunk`. No I/O.
- `src/ai/summary-generator.js` — orchestrates per-review summary generation.
- `src/ai/tour-generator.js` — orchestrates per-review tour generation.
- `src/ai/background-queue.js` — bounded-concurrency in-process queue with dedup keyed on `(reviewId, jobType)`.
- `src/utils/diff-hunks.js` (only if existing helpers don't expose hunk-level slicing) — `parseHunks(diffText)`.

### Backend (modified)
- `src/config.js` — add `summary_provider`/`summary_model`/`background_concurrency` to `DEFAULT_CONFIG`; export `getSummaryProvider`, `getSummaryModel`.
- `src/database.js` — bump `CURRENT_SCHEMA_VERSION` to 46; add `hunk_summaries` + `tours` to `SCHEMA_SQL`; add migrations 45 and 46; add indexes; add `HunkSummaryRepository` and `TourRepository`; export both.
- `src/local-review.js` — after diff persistence in CLI start path, enqueue `summaries` job. Resolve background config via deps from caller; do NOT re-read config.
- `src/routes/local.js` — same enqueue at end of `POST /api/local/start` and in `GET /api/local/:reviewId`.
- `src/routes/pr.js` — same enqueue at end of `GET /api/pr/:owner/:repo/:number`.
- `src/routes/analyses.js` — add ID-based endpoints:
  - `GET /api/reviews/:reviewId/hunk-summaries` → `{summaries: [{file_path, content_hash, summary_text}]}`.
  - `GET /api/reviews/:reviewId/tour` → `{tour: {stops, hash_set, stale: bool}}`.
- `src/server.js` — wire in the background queue singleton at startup.
- `config.example.json` — document new keys.

### Frontend (new)
- `public/js/modules/hunk-summary-renderer.js`
- `public/js/modules/tour-renderer.js`
- `public/js/components/TourBar.js` — follows the `if (typeof module !== 'undefined')` testability pattern.

### Frontend (modified)
- `public/js/pr.js` — toolbar buttons (toggle summaries, start tour); WS subscriptions; render orchestration; keyboard shortcuts when tour active.
- `public/js/local.js` — only if any overridden method needs to also handle the new event types.
- `public/css/pr.css` — `.hunk-summary-annotation`, `.tour-annotation`, light + dark variants, `body.tour-active .hunk-summary-annotation { display: none; }`.

### Tests (new)
- `tests/unit/hunk-hashing.test.js`
- `tests/unit/summary-generator.test.js`
- `tests/unit/tour-generator.test.js`
- `tests/unit/background-queue.test.js`
- `tests/unit/hunk-summary-repository.test.js`
- `tests/unit/tour-repository.test.js`
- `tests/integration/pr-summaries.test.js`
- `tests/integration/local-summaries.test.js`
- `tests/e2e/hunk-summaries.spec.js`
- `tests/e2e/tour.spec.js`

### Tests (modified)
- `tests/e2e/global-setup.js` — add `hunk_summaries` and `tours` tables to schema mirror.
- `tests/integration/routes.test.js` — same.

---

## Prompt Design Notes

### Summary prompt contract (`src/ai/prompts/hunk-summary.js`)
- **Input shape**:
  ```
  File: <path>
  Hunks (numbered):
  [1] @@ <hunk header> @@
  <hunk content>
  [2] @@ ... @@
  <hunk content>
  ```
  Plus the worktree path (`cwd`) as the FS-access invitation, the author's stated intent (PR title/description or local-review name) as a *hint only*, and the changed-files list as light context.
- **Output JSON schema** (extracted via `extractJSON`):
  ```json
  { "summaries": [
      { "index": 1, "summary": "Adds X to do Y." },
      { "index": 2, "summary": null }
  ] }
  ```
  `summary` is `string | null`. Indexes match the `[N]` labels in the hunk block. No extra fields, no prose outside the JSON.
- **Length**: 1–3 sentences, target ~200 characters, hard ceiling 400. Aim for one sentence; use a second only when it adds information the first cannot. No truncation in code — the prompt sets the budget and we trust the model.
- **Style**: lead with a verb (Adds, Removes, Renames, Refactors, Fixes, Moves, Inlines, Extracts). For mechanical changes, say so in one short sentence and stop. Examples shown in the prompt are 3rd-person indicative ("Adds…"); the model follows the examples.
- **Null summaries (model opt-out)**: the model MAY return `summary: null` when ALL of (a) the change is purely mechanical (whitespace, import reorder, lint fix, trivial rename) AND (b) a reader scanning the diff would learn nothing from a summary. The prompt explicitly says *"Default is to summarize. When in doubt, write the summary."* — load-bearing. Persistence: explicit nulls land as `trivial_reason: 'model_skipped'`; missing/invalid entries or top-level malformed responses land as `trivial_reason: 'model_malformed'`. Both prevent re-enqueue on reload; the distinct reasons are for observability (grep for provider quality issues).
- **FS access invitation (when `cwd` is set)**: the prompt tells the agent it has read-only access to the working directory and MAY consult adjacent code ONLY when it materially improves the description of WHAT changed (e.g., a symbol's caller graph that turns "adds a helper" into "extracts a helper now used by 4 sites"). Tool-budget guidance is prompt-level: at most ~5 file reads, ~3 grep calls per file; no broad browsing, no tests/fixtures/generated files unless directly relevant, no modifications. The runtime contract is the existing `provider.execute()` path (which already takes `cwd`); we do **not** add a parallel agent-task abstraction. Read-only-ness for v1 is enforced by prompt + provider conventions, not a new sandbox layer.
- **Author-claims framing**: the data block is labeled `"Author's stated intent (hint only — verify against the diff):"`. A follow-up paragraph instructs the model to use the description for orientation/vocabulary only, not to repeat or paraphrase it; if the diff and description disagree, describe the diff (no editorializing); if the description is vague/templated/empty, ignore it entirely. The diff is ground truth; the description is a hint.
- **Speculation guardrail**: the prompt closes the FS-access block with *"The summary still describes what the DIFF changes, not what the surrounding code does. Context informs phrasing; it does not become the subject."* Without this, "context-aware" drifts into "summary of the file."
- **Cache hashing**: `content_hash` keys per-review (`UNIQUE(review_id, content_hash)`). Within a review, surrounding-code drift can produce stale-but-served summaries — acceptable for v1 ("summaries lag mid-flight"). Cross-review collision is prevented by the per-review key. Hash is over hunk content + path; we do not widen it to surrounding code.

### Tour prompt contract (`src/ai/prompts/tour.js`)
- **Input shape**:
  ```
  PR title / local-review name
  PR description (or empty)
  Summaries by file (in repo order):
    File: <path>
      [hash]: <summary>
      [hash]: <summary>
  ```
- **Output JSON schema**:
  ```json
  { "stops": [
      {
        "file_path": "src/foo.ts",
        "content_hash": "abc...",
        "title": "<<= 60 chars>>",
        "description": "<<= 280 chars>>"
      }
  ] }
  ```
  Stops are non-linear; the model orders them as a coherent narrative. Length: 3–10 stops; reject and retry once if outside bounds. Validate every `content_hash` is in the input set; drop and warn on mismatch.
- **Length constraints**: title 60 chars, description 280 chars. Strictly linear navigation in v1.

---

## Background Job / Queue Model

- **Trigger** at the four entry points listed in Phase 4. All four call `backgroundQueue.enqueue(reviewId, 'summaries', () => generateSummariesForReview(...))`. The summary job's completion handler enqueues `(reviewId, 'tour', () => generateTourForReview(...))`.
- **Dedup**: keying on `(reviewId, jobType)` ensures rapid reloads don't pile up duplicate work. If a job is already running or queued for a key, `enqueue` returns the existing promise.
- **Concurrency**: process-wide cap (default 2, configurable). Per-review serialization (only one job per `(reviewId, jobType)` at a time).
- **Frontend notification**: WebSocket via the existing `broadcastReviewEvent` → `review:{reviewId}` topic infrastructure. Event types:
  - `review:hunk_summaries_ready` (per-file, payload `{filePath, summaries}`).
  - `review:tour_ready` (per-review).
  - `review:background_job_finished` (jobType) — generic, for telemetry / future use.
- **Why WebSocket, not SSE/poll**: codebase already migrated SSE → WS; review-scoped events route through `broadcastReviewEvent` using `review:{reviewId}` topics; frontend `wsClient` is a singleton with auto-reconnect + topic resubscription. Reuse this.
- **Cancellation**: not needed in v1. Browser-tab close does not cancel; next reload either gets cached results or re-enqueues missing hashes. Background jobs MUST never call `open()` (`PAIR_REVIEW_NO_OPEN`); they don't, since they don't go through `local-review.js`'s open path.

---

## Config Schema Extension

New keys in `~/.pair-review/config.json`:

```json
{
  "summaries_enabled": false,
  "tours_enabled": false,
  "summary_provider": "claude",
  "summary_model": "haiku"
}
```

**Feature toggles** (both default `false` for v1; opt-in until early adopters validate):

- `summaries_enabled` — when `false`, no summary jobs enqueued, no summary endpoints called, no toolbar/file/hunk toggles rendered. Feature is *completely hidden*.
- `tours_enabled` — when `false`, no tour jobs enqueued, no Start Tour button, no tour endpoint calls. Feature is completely hidden.
- Tours depend on summaries. If `tours_enabled=true` but `summaries_enabled=false`, log a warning at startup and treat tours as disabled.

**Provider resolution** (`getSummaryProvider` / `getSummaryModel` in `src/config.js`):

1. If `summary_provider` is set → use it.
2. Else fall back to `default_provider` (existing users get *some* working behavior).
3. For `summary_model`:
   1. If `summary_model` set → use it.
   2. Else, if the resolved provider has a `fast`-tier model (via `provider.getFastTierModel()`), use that.
   3. Else fall back to `default_model`.

Rationale: fast-tier fallback is the right default — summaries / tours are bulk text-summarization tasks where speed dominates. Explicit override exists for users who want a specific model.

**Concurrency**: hardcoded constant `BACKGROUND_QUEUE_CONCURRENCY = 2` in `src/ai/background-queue.js`. Not exposed as config in v1; revisit if real workloads show it matters.

---

## Trivial-Hunk Heuristic

Run in this order; first match wins:

1. **Generated file** — if `filePath` matches a `.gitattributes` `linguist-generated` pattern (use existing `getGeneratedFilePatterns` from `src/git/gitattributes.js`), trivial (`reason: 'generated'`).
2. **Pure whitespace** — strip all `+`/`-` line markers, then strip whitespace from added vs. removed lines; if equal, trivial (`reason: 'whitespace'`).
3. **Import-only reorder** — if every added line and every removed line matches `^\+import\b|^\+from .* import\b|^\+(const|let|var) \w+ = require\(` (and negative variants), AND the multiset of added lines equals the multiset of removed lines, trivial (`reason: 'imports'`). Language scope v1: JS/TS/Python only.
4. **Version bump / lockfile** — if `filePath` ∈ {`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `Pipfile.lock`, `poetry.lock`, `composer.lock`, `go.sum`}, AND only changed lines match version-bump patterns (or are inside a lockfile), trivial (`reason: 'version_bump'`).
5. **Tiny hunk** — if total non-marker lines added + removed ≤ 1, trivial (`reason: 'tiny'`).

When trivial, persist a row with `summary_text = NULL` (or sentinel `__TRIVIAL__:reason`) so the left-join logic correctly treats it as "already known, don't re-enqueue". Frontend hides these.

---

## Hazards

- **`broadcastReviewEvent` callers**: many. We add new event types, not changing the function signature, so existing callers are unaffected. New event type strings must be unique to avoid collisions with current types: `review:hunk_summaries_ready`, `review:tour_ready`, `review:background_job_finished`.

- **`createProvider` callers**: high-risk if changed; we don't change it but add new caller paths inside `summary-generator.js` and `tour-generator.js`. Verify the new callers respect the same `_deps` / config-resolution discipline as `src/ai/analyzer.js` (do NOT re-read `loadConfig()` inside; accept resolved values as args).

- **Three analyzer code paths in `src/ai/analyzer.js`** — `analyzeAllLevels`, `runReviewerCentricCouncil`, `runCouncilAnalysis`. Summary/tour generation does NOT go through Analyzer — it uses `provider.execute()` directly. Therefore none of these three needs editing for this feature, BUT verify we do not bake summary-generation into the Analyzer constructor. If a future refactor moves background-task generation under Analyzer, all three paths must be updated.

- **Async race: review reload while background job in flight.** Two browser tabs open the same `reviewId` simultaneously, or a user reloads mid-generation. The queue's per-`(reviewId, jobType)` dedup must hold; `enqueue` must return the existing promise. Test this explicitly.

- **Async race: hunks change between enqueue and execute.** A local-mode user edits a file after `POST /api/local/start` enqueues summaries. The job's hashes were captured at enqueue time. On execute, re-derive hashes from the current `local_diffs` row to avoid persisting stale summaries. Tour generation has the same hazard — re-derive hash-set just before persistence.

- **Completion handler assumption: WS broadcast on completion.** Summary job's `onComplete` enqueues the tour job. If `summary` succeeds for some files but fails for others, partial WS broadcasts have already gone out (good). The tour-enqueue handler must accept partial completion — if any summaries are missing for non-trivial hunks, do NOT generate the tour for that review (mark a state flag and broadcast `review:tour_skipped` so the UI hides the Start Tour button).

- **WS topic-subscription race in `src/ws/server.js`**: existing guarded race for `poolLifecycle.startSession`. New event types ride the same `review:{reviewId}` topic. No new race.

- **`local.js` patches `pr.js` `PRManager`**: per CLAUDE.md "Local Mode and PR Mode Parity," features added to `pr.js` automatically reach local mode if the constructor wires them up before `local.js`'s patches override methods. The `_initReviewEventListeners` precedent confirms this pattern works for review-scoped WS events. New listeners must be registered in `_initReviewEventListeners` so both paths inherit them. Verify after Phase 5 / Phase 8 that no toolbar button or keyboard handler we add is silently overridden by a local-mode patch.

- **Migration safety**: `hunk_summaries` and `tours` migrations create new tables, so they cannot conflict with existing data. They MUST still wrap DDL in a transaction and use `CREATE TABLE IF NOT EXISTS` plus `CREATE INDEX IF NOT EXISTS`.

- **`PAIR_REVIEW_NO_OPEN` discipline**: new background paths must never call `open()`. `summary-generator.js` and `tour-generator.js` only call `provider.execute()` and DB writes. The four trigger sites all already respect `PAIR_REVIEW_NO_OPEN` for their browser-open behavior; we add work BEFORE the open call in `local-review.js`.

- **CLI vs Web UI parity**: `src/local-review.js` (CLI) AND `src/routes/local.js` `POST /api/local/start` (web UI) both create local sessions. Per CLAUDE.md, both need to fire generation. Easiest implementation: shared helper `_kickOffBackgroundJobs(reviewId, deps)` in a new helper module under `src/ai/`. The `GET /api/local/:reviewId` and `GET /api/pr/.../number` handlers also enqueue (load-time enqueue covers reloads).

- **Logging**: use `src/utils/logger.js` (`logger.info`/`debug`/`warn`/`error`). No `console.log`/`console.error` in any new server code.

---

## Resolved Decisions

1. **Trivial-hunk persistence**: persist with sentinel; skipped uniformly via missing-hash query.
2. **Tour stop annotation placement**: above existing comments/suggestions/summary on the same hunk — visual anchor on scroll.
3. **Summaries-hidden toggle persistence**: per-review in `localStorage` keyed by `reviewId`. Good enough for most users.
4. **Stale tour**: show the old tour with a "regenerating…" badge — stale beats nothing.
5. **Concurrency**: hardcoded constant (2). No config key.
6. **PR-mode file cap**: default 50, configurable via `summaries_max_files`. Skip + surface a notice for larger diffs.
7. **Missing background provider**: log once per review at `info`, then silently no-op.
8. **Tour keyboard shortcuts**: scoped to `body.tour-active` to avoid collisions.

**Feature gating (added)**: both features default `false` in config. When disabled, completely hidden — no enqueue, no endpoints, no UI affordances.
