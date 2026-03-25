# Plan: Global Instructions Support

## Context

Issue #391. Users need a way to set instructions that apply to **all** reviews across all repositories — a "global" layer above repo-specific instructions. The file `~/.pair-review/global-instructions.md` is read once at analysis start and injected before repo and custom instructions in every review/consolidation prompt. No UI. The instructions are persisted in `analysis_runs` for auditability.

## Instruction Hierarchy (lowest → highest precedence)

```
global → repo → custom/instance
```

## Hazards

- `mergeInstructions()` is called from:
  - `src/routes/pr.js:1528` (PR analysis start)
  - `src/routes/local.js:1015` (Local analysis start)
  - `src/ai/analyzer.js:182` (inside `analyzeAllLevels` when receiving object-format instructions)
  - Adding a parameter changes the signature; all three callers must be updated.
- `AnalysisRunRepository.create()` (database.js:3487) — adding `globalInstructions` param; SQL column list and VALUES must stay in sync.
- `buildCustomInstructionsSection()` in analyzer.js is called from ~9 places (L1/L2/L3 prompts, orchestration, consolidation). It receives the **merged** string, so no changes needed there — merging happens upstream.

## Changes

### 1. `src/utils/instructions.js` — Add `loadGlobalInstructions()` + update `mergeInstructions()`

**`loadGlobalInstructions()`**: New exported function.
- Reads `~/.pair-review/global-instructions.md` using `fs.readFileSync` (sync is fine — called once per analysis, tiny file).
- Uses `getConfigDir()` from `src/config.js` (already resolves to `~/.pair-review/`).
- Returns trimmed content or `null` if file doesn't exist or is empty.

**`mergeInstructions(globalInstructions, repoInstructions, requestInstructions)`**: Add `globalInstructions` as first parameter.
- If present, prepend wrapped in `<global_instructions>` tags with a preamble: "These are global instructions that apply to all reviews:"
- Precedence prose: repo says it takes precedence over global; custom says it takes precedence over repo.

### 2. `src/database.js` — Migration 34 + schema + repository

- Bump `CURRENT_SCHEMA_VERSION` from 33 → 34.
- Add migration 34: `ALTER TABLE analysis_runs ADD COLUMN global_instructions TEXT`.
- Update `analysis_runs` CREATE TABLE schema to include `global_instructions TEXT` after `request_instructions`.
- Update `AnalysisRunRepository.create()`: add `globalInstructions = null` param, add to INSERT column list and VALUES.

### 3. `src/routes/pr.js` — Thread global instructions

In the POST `/api/pr/:owner/:repo/:number/analyses` handler (~line 1504):
- Import `loadGlobalInstructions` from `src/utils/instructions.js`.
- Call `const globalInstructions = loadGlobalInstructions();` alongside repo settings fetch.
- Update `mergeInstructions(globalInstructions, repoInstructions, requestInstructions)`.
- Pass `globalInstructions` to `analysisRunRepo.create()`.
- Pass `globalInstructions` in the instructions object to `analyzer.analyzeLevel1()`: `{ globalInstructions, repoInstructions, requestInstructions }`.

### 4. `src/routes/local.js` — Thread global instructions

Same pattern as PR route, in POST `/api/local/:reviewId/analyses` handler (~line 988).

### 5. `src/ai/analyzer.js` — Accept global instructions in object format

In `analyzeAllLevels()` (~line 178):
- Extract `globalInstructions` from the instructions object.
- Pass to `mergeInstructions(globalInstructions, repoInstructions, requestInstructions)`.
- Pass `globalInstructions` to `analysisRunRepo.create()`.

### 6. `tests/utils/schema.js` — Update test schema

Add `global_instructions TEXT` to `analysis_runs` CREATE TABLE.

### 7. `tests/unit/instructions.test.js` — Update + add tests

- Update existing `mergeInstructions` tests to pass `null` as first arg.
- Add tests for:
  - `loadGlobalInstructions()` — file exists, file doesn't exist, file empty.
  - `mergeInstructions()` with global instructions — alone, with repo, with all three, precedence ordering.

### 8. Regenerate skill prompts

Run `node scripts/generate-skill-prompts.js` — the prompt templates themselves don't change (still `{{customInstructions}}`), but the merged content fed into that placeholder now includes global instructions. No template changes needed. Regeneration is precautionary.

## Files Modified

| File | Change |
|------|--------|
| `src/utils/instructions.js` | Add `loadGlobalInstructions()`, update `mergeInstructions()` signature |
| `src/database.js` | Migration 34, schema, `create()` method |
| `src/routes/pr.js` | Load + thread global instructions |
| `src/routes/local.js` | Load + thread global instructions |
| `src/ai/analyzer.js` | Extract + pass global instructions |
| `tests/utils/schema.js` | Add column to test schema |
| `tests/unit/instructions.test.js` | Update + add tests |

## Verification

1. **Unit tests**: `npm test -- tests/unit/instructions.test.js`
2. **Integration tests**: `npm test -- tests/integration/` (verifies DB migration and schema)
3. **Manual test**: Create `~/.pair-review/global-instructions.md` with content, run a local review analysis, verify the instructions appear in the analysis_runs record and in the prompt (check logs).
4. **E2E tests**: `npm run test:e2e` (verifies nothing broke)
