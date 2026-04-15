# Persist Per-Level Analysis Outcomes

## Context

The analysis-run history shows L1/L2/L3 indicators: green check if the level was configured to run, grey X at 0.5 opacity if it was skipped. The problem:

1. The indicators only reflect **what was requested** (`levels_config`), not **what actually happened**. A level can fail at runtime and still render as a green check.
2. Per-level outcome is computed in-memory (`levelResults` in [`src/ai/analyzer.js:459`](src/ai/analyzer.js:459)) and streamed over the progress socket, but **never persisted**. If you navigate away or refresh, the information is lost.
3. Consolidation ("orchestration") is also a discrete step that can succeed or fail ([`analyzer.js:519`](src/ai/analyzer.js:519) try/catch with fallback), but isn't surfaced at all.

Goal: persist a four-slot outcome record per run — L1, L2, L3, C — and display it with iconography that distinguishes success (green ✓), failure (red ✗), and skipped (neutral grey middot `·`). Legacy runs (no persisted outcome) fall back to the current `levels_config`-driven display using the new neutral middot for skipped.

## Data Model

New column on `analysis_runs`:

```
level_outcomes TEXT  -- JSON
```

Shape:

```json
{
  "level1": "success" | "failed" | "skipped",
  "level2": "success" | "failed" | "skipped",
  "level3": "success" | "failed" | "skipped",
  "consolidation": "success" | "failed" | "skipped"
}
```

Keys are **optional**. A council **parent** run only writes `consolidation` (its L1/L2/L3 run on child reviewer runs). A council **child** run writes all four keys like a normal single run. The frontend renders only the keys that are present, so the parent shows just a `C` and children show `L1 L2 L3 C`.

## Backend Changes

### 1. Database migration — [`src/database.js`](src/database.js)

Bump the schema version and add an idempotent migration that mirrors the existing `levels_config` pattern at [`database.js:966`](src/database.js:966):

```js
const hasLevelOutcomes = columnExists(db, 'analysis_runs', 'level_outcomes');
if (!hasLevelOutcomes) {
  try {
    db.prepare(`ALTER TABLE analysis_runs ADD COLUMN level_outcomes TEXT`).run();
  } catch (error) {
    if (!error.message.includes('duplicate column name')) throw error;
  }
}
```

Also add `'level_outcomes'` to the update-field whitelists at [`database.js:4383`](src/database.js:4383), [`database.js:4411`](src/database.js:4411), and [`database.js:4449`](src/database.js:4449), and to the INSERT at [`database.js:4296`](src/database.js:4296). The column stores a JSON string; serialize on write, parse on read.

### 2. Analyzer — [`src/ai/analyzer.js`](src/ai/analyzer.js)

The hard work is already done. `levelResults` at line 459 already holds per-level `status`, and orchestration success/failure is already distinguishable (the try/catch at line 519; the `orchestrationFailed: true` return flag at line 625).

**`analyzeAllLevels`** (line 326):
- Derive `levelOutcomes` from `levelResults` just before each `analysisRunRepo.update(...)` call (lines 554, 609):
  - `{ level1: levelResults.level1.status, level2: ..., level3: ..., consolidation: 'success' }` in the happy path.
  - `consolidation: 'failed'` in the fallback path (line 609).
- If a level's `status` is `'skipped'`, keep `'skipped'`. No `'running'` states leak because we're past `Promise.allSettled`.
- Pass `levelOutcomes` into the `analysisRunRepo.update` call alongside `status` / `summary` / etc.
- Add `levelOutcomes` to the returned object at lines 568 and 620 so callers can inspect it.

**`runReviewerCentricCouncil`** (line 2834) and **`runCouncilAnalysis`** (line 3362):
- **Child reviewer runs**: already invoke `analyzeAllLevels`; they'll pick up the new column via the existing update call. No changes needed in the child path.
- **Parent council run**: at the end, when the parent's own cross-reviewer consolidation completes, update the parent row with `level_outcomes: { consolidation: 'success' }` (or `'failed'`). Grep these two functions for their existing `analysisRunRepo.update(parentRunId, { status: 'completed', ... })` call sites and add the field there.

### 3. Route layer — [`src/routes/analyses.js`](src/routes/analyses.js)

`enrichRun` at line 47 already parses `levels_config`. Add a parallel line:

```js
level_outcomes: run.level_outcomes ? JSON.parse(run.level_outcomes) : null,
```

No other route changes needed — the analyzer writes the column directly via `analysisRunRepo.update`, and the GET endpoint is the only consumer.

### 4. Failure paths

If the analyzer throws **before** `Promise.allSettled` runs (config errors, worktree errors), `levelResults` is never populated. The route-level error handlers (`catch` blocks in [`src/routes/pr.js`](src/routes/pr.js), [`src/routes/local.js`](src/routes/local.js), [`src/routes/analyses.js`](src/routes/analyses.js), [`src/routes/executable-analysis.js`](src/routes/executable-analysis.js), [`src/routes/stack-analysis.js`](src/routes/stack-analysis.js), [`src/routes/mcp.js`](src/routes/mcp.js)) that mark the run `status: 'failed'` should leave `level_outcomes` as `NULL`. The frontend falls back to `levels_config`-based rendering for null outcomes, which is correct behavior for "never ran".

## Frontend Changes

### 1. [`public/js/modules/analysis-history.js`](public/js/modules/analysis-history.js) — `renderLevelIndicators` (line 890)

Rewrite to a two-mode function:

```js
renderLevelIndicators(run) {
  const outcomes = run.level_outcomes;
  const config = run.levels_config;

  // Build slot list: [{ label, outcome }, ...]
  const slots = [];
  const addSlot = (label, outcome) => {
    if (outcome) slots.push({ label, outcome });
  };

  if (outcomes) {
    // New path: use persisted outcomes
    addSlot('L1', outcomes.level1);
    addSlot('L2', outcomes.level2);
    addSlot('L3', outcomes.level3);
    addSlot('C',  outcomes.consolidation);
  } else if (config) {
    // Legacy fallback: derive from config only. No failure state, no C slot.
    for (const level of [1, 2, 3]) {
      const enabled = Array.isArray(config)
        ? config.includes(level)
        : config[`level${level}`] !== false;
      addSlot(`L${level}`, enabled ? 'success' : 'skipped');
    }
  } else {
    return '';
  }

  const icon = { success: '\u2713', failed: '\u2717', skipped: '\u00B7' };
  const cls  = { success: 'level-success', failed: 'level-failed', skipped: 'level-skipped' };

  const html = slots
    .map(s => `<span class="analysis-history-level ${cls[s.outcome]}">${s.label}${icon[s.outcome]}</span>`)
    .join('');
  return `<span class="analysis-history-levels">${html}</span>`;
}
```

Key behaviors:
- New runs with `level_outcomes`: 3–4 slots, tri-state icons.
- Legacy runs: 3 slots (no `C`), green check for enabled, neutral middot for skipped. **No failure state** — we don't know.
- Council parent run: only `C` slot (because only `consolidation` is set in `level_outcomes`).

### 2. CSS — [`public/css/pr.css`](public/css/pr.css:8002)

Replace `.level-on` / `.level-off` with three classes:

```css
.analysis-history-level.level-success {
  color: var(--color-success, #22c55e);
}

.analysis-history-level.level-failed {
  color: var(--color-danger, #ef4444);
}

.analysis-history-level.level-skipped {
  color: var(--color-text-muted);
  opacity: 0.5;
}
```

Verify the correct danger-color CSS variable by grepping for existing usage (e.g., `--color-danger`, `--color-error`, `--color-red`) — reuse the project's established token, don't introduce a new one.

## Tests

### Schema updates (required per CLAUDE.md)

- [`tests/e2e/global-setup.js:370`](tests/e2e/global-setup.js:370) — add `level_outcomes TEXT` to the test schema.
- [`tests/integration/routes.test.js:2422`](tests/integration/routes.test.js:2422) — same.

### New unit tests

Add a test file (`tests/unit/analysis-history-level-indicators.test.js` or extend [`tests/unit/analysis-history.test.js`](tests/unit/analysis-history.test.js)) covering:

1. All succeed → `L1✓ L2✓ L3✓ C✓`, all green.
2. L2 failed → `L1✓ L2✗ L3✓ C✓`, L2 has `.level-failed`.
3. L3 skipped by config → `L1✓ L2✓ L3· C✓`, L3 has `.level-skipped`.
4. Consolidation failed → `L1✓ L2✓ L3✓ C✗`.
5. Legacy run (`level_outcomes: null`, `levels_config: [1, 2]`) → `L1✓ L2✓ L3·`, no `C` slot.
6. Council parent (`level_outcomes: { consolidation: 'success' }`) → only `C✓`.
7. Empty run (no outcomes, no config) → returns `''`.

### New analyzer unit tests

Extend [`tests/unit/analyzer`-style tests](tests/unit) to assert `levelResults` → `levelOutcomes` mapping for: all-success, single-level-failure, all-skipped-except-one, orchestration-failure (fallback path).

### Integration test

Extend [`tests/integration/routes.test.js`](tests/integration/routes.test.js): insert an `analysis_runs` row with `level_outcomes` JSON, `GET /api/analyses/runs/:id`, assert the parsed object round-trips.

### E2E test (optional but recommended)

Extend [`tests/e2e/ai-analysis.spec.js`](tests/e2e/ai-analysis.spec.js) or create a sibling: verify the indicator badges render with the correct classes after a completed run.

## Hazards

> **Three analyzer paths** — per CLAUDE.md, `analyzeAllLevels`, `runReviewerCentricCouncil`, and `runCouncilAnalysis` must all be updated. `analyzeAllLevels` carries the bulk; the council paths need to populate `consolidation` on the **parent** run row at their own final-update site.
>
> **Six route-level error handlers** — [`pr.js`](src/routes/pr.js), [`local.js`](src/routes/local.js), [`analyses.js`](src/routes/analyses.js), [`executable-analysis.js`](src/routes/executable-analysis.js), [`stack-analysis.js`](src/routes/stack-analysis.js), [`mcp.js`](src/routes/mcp.js). Each has a `catch` block that marks the run failed. Leave `level_outcomes` as NULL in those paths; the frontend fallback renders correctly.
>
> **Migration idempotency** — follow the pattern at [`database.js:966`](src/database.js:966) exactly. Guard with `columnExists` AND catch `duplicate column name` for race safety. Also remember the update-field whitelist at three separate sites ([`4383`](src/database.js:4383), [`4411`](src/database.js:4411), [`4449`](src/database.js:4449)).
>
> **`levels_config` has two formats** (array from voice-centric, object from advanced). The legacy-fallback branch of `renderLevelIndicators` already handles both — preserve that when rewriting.
>
> **Legacy runs have no "C" data** — the fallback branch must not render a `C` slot when outcomes are absent. Rendering `C·` would imply consolidation was skipped, which is usually false.
>
> **Parent vs child council runs** — parent writes only `consolidation`; children write all four. Getting this wrong would either double-display `C` or lose per-level visibility on child runs.
>
> **Icon encoding** — middot is U+00B7 (`·`), not a regular period. Use `\u00B7` in source to avoid stray encoding drift.
>
> **CSS variable name** — verify the danger/error color token in use before committing to `--color-danger`.

## Changeset

Minor version bump. User-facing UI change with new persisted data. Add `.changeset/*.md` describing: "Analysis-run history now shows per-level success/failure status (previously only showed which levels were configured to run). Consolidation step is also surfaced."

## Verification

1. `pnpm test` — unit + integration tests pass, including the new ones.
2. Start the app against an existing database; migration runs cleanly. Old runs still render with the legacy fallback (green checks / grey middots, no `C`).
3. Run a fresh analysis. Assert the indicator shows `L1✓ L2✓ L3✓ C✓` (all green).
4. Force a failure: temporarily inject a throw in `analyzeLevel2Isolated`. Run analysis, assert history row shows `L1✓ L2✗ L3✓ C✓`. Remove the injection.
5. Run a council analysis. Parent row shows only `C✓`. Child reviewer rows show `L1✓ L2✓ L3✓ C✓`.
6. `pnpm test:e2e` — E2E tests pass.

## Out of Scope

- Per-voice outcomes on the council parent (parent shows only `C`, per user decision).
- Timing/duration per level.
- Retry-failed-level UI.
- Backfilling `level_outcomes` for existing runs.
