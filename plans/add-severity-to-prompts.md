# Add Severity to AI Review Prompts

## Context

Executable providers (Binks) produce a `severity` field on suggestions (`critical|medium|minor`), but pair-review's own AI prompts (L1/L2/L3) don't produce severity, and the orchestration/consolidation prompts don't know about it. When council mode merges executable provider results with native results, severity gets dropped during curation because the AI isn't told to preserve it.

The database column already exists, the frontend already renders severity badges, and the executable provider mapping already handles it. The gap is purely in the prompt output schemas.

## Severity Definitions

```
critical — Will cause production incidents, system failures, or test failures: runtime crashes, null pointer errors,
           SQL injection, auth bypasses, data corruption, deadlocks, memory leaks, breaking API changes without
           migration, changes that will cause existing tests to fail.
medium   — Will degrade functionality or reliability: N+1 queries, missing error handling on critical paths, improper
           transaction handling, config errors, missing input validation, incorrect status codes, missing tests for
           new functionality.
minor    — Code quality concerns that don't affect functionality: documentation gaps, minor performance optimizations,
           style inconsistencies.
```

## Files to Modify

### Shared output schema (1 file)
- `src/ai/prompts/shared/output-schema.js` — Add `severity` to all schema objects and `ORCHESTRATION_INPUT_SCHEMA_DOCS`

### Level prompt output schemas (9 files — 3 levels x 3 tiers)
Each has an inline `output-schema` locked section with a JSON example. Add `"severity": "critical|medium|minor"` to the suggestion objects.

- `src/ai/prompts/baseline/level1/balanced.js`
- `src/ai/prompts/baseline/level1/fast.js`
- `src/ai/prompts/baseline/level1/thorough.js`
- `src/ai/prompts/baseline/level2/balanced.js`
- `src/ai/prompts/baseline/level2/fast.js`
- `src/ai/prompts/baseline/level2/thorough.js`
- `src/ai/prompts/baseline/level3/balanced.js`
- `src/ai/prompts/baseline/level3/fast.js`
- `src/ai/prompts/baseline/level3/thorough.js`

### Orchestration prompt output schemas (3 files)
Add `severity` to output schema AND add a guideline to preserve severity from input suggestions.

- `src/ai/prompts/baseline/orchestration/balanced.js`
- `src/ai/prompts/baseline/orchestration/fast.js`
- `src/ai/prompts/baseline/orchestration/thorough.js`

### Consolidation prompt output schemas (3 files)
Add `severity` to output schema AND add a guideline to preserve severity from input suggestions.

- `src/ai/prompts/baseline/consolidation/balanced.js`
- `src/ai/prompts/baseline/consolidation/fast.js`
- `src/ai/prompts/baseline/consolidation/thorough.js`

### Skill prompt regeneration
- Run `node scripts/generate-skill-prompts.js` after all prompt changes

## Change Details

### 1. Shared output-schema.js

Add `severity` field to every schema's `suggestions` array item and to `fileLevelSuggestions` where present:
```js
severity: 'critical|medium|minor',
```

Add severity to `ORCHESTRATION_INPUT_SCHEMA_DOCS`:
```
- severity: "critical", "medium", or "minor" (may be null)
```

### 2. Level prompts (L1/L2/L3, all tiers)

In the inline `output-schema` locked section, add `"severity"` to the JSON example after `"type"`:
```json
"severity": "critical|medium|minor",
```

Also add a severity definition section (required, not locked) to each level prompt, placed after the category-definitions/focus-areas section. For L1 this goes after `category-definitions`. For L2/L3, add to the guidelines or as a new section:

```
### Severity Classification
Assign a severity to each suggestion (except praise):
- **critical**: Production incidents, system failures, or test failures — crashes, security vulnerabilities, data corruption, breaking changes, changes that will cause tests to fail
- **medium**: Degraded functionality or reliability — missing error handling, N+1 queries, missing validation, missing tests for new functionality
- **minor**: Code quality concerns — documentation gaps, minor optimizations, style inconsistencies
Omit severity for praise items.
```

### 3. Orchestration prompts (all tiers)

Add `"severity": "critical|medium|minor"` to the output-schema JSON example.

Add a severity preservation rule to the `intelligent-merging` section:
```
- **Preserve severity** from input suggestions when merging. When combining suggestions with different severities, use the highest severity.
```

### 4. Consolidation prompts (all tiers)

Add `"severity": "critical|medium|minor"` to the output-schema JSON example.

Add a severity preservation rule to the `consolidation-rules` section:
```
- **Preserve severity** from input suggestions. When merging duplicates with different severities, use the highest.
```

## Hazards

- **15 prompt files** with inline output-schema sections that must all be updated consistently
- **Locked sections**: The output-schema sections are `locked="true"`, meaning variants can't override them — but we're changing the baseline, so this is fine
- **Three independent analysis code paths** in `analyzer.js` (`analyzeAllLevels`, `runReviewerCentricCouncil`, `runCouncilAnalysis`) — no code changes needed since severity flows through the existing suggestion objects, but the prompts feed all three paths
- The `_crossVoiceConsolidate` method passes full suggestion JSON including severity — the consolidation prompt just needs to know to preserve it

## Verification

1. Run `node scripts/generate-skill-prompts.js` — confirm it succeeds
2. Run `npm test` — confirm no regressions
3. Run a local analysis to verify severity appears in native AI results
4. Run a council analysis with an executable provider to verify severity is preserved through consolidation
