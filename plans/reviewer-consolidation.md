# Task: reviewer consolidation

## Description
when pair-review runs a council with parallel reviewers it runs a consolidation step at the end. that is supposed to perform a similar task to the orchestration across levels for a single reviewer. However, what I'm observing is that it seems to just concatenate summaries. And it may just be returning the union of all suggestions instead of any intelligent deduplication.

## Spec
Now I have everything I need to write the spec. Let me produce it.

---

# Implementation Spec

## Problem Analysis

Three independent failures, each contributing to the user's observation:

### 1. Below-threshold path is the primary culprit (`analyzer.js:3098–3123`)

`runReviewerCentricCouncil` skips AI consolidation entirely when `totalSuggestionCount < COUNCIL_CONSOLIDATION_THRESHOLD` (8). In that path:
- **Summary**: `voiceSummaries.join('\n\n')` — this is literal string concatenation
- **Suggestions**: `allVoiceSuggestions` passed straight to `validateAndFinalizeSuggestions` — a structural union with zero deduplication

A 2-reviewer council where each finds ≤3 suggestions (6 total < 8) hits this path every time. For smaller PRs this is the common case. The threshold was added to avoid a wasted AI call on tiny inputs, but it produces output that is objectively worse than a single-reviewer run.

### 2. Consolidation prompt lacks output-reduction guidance

`src/ai/prompts/baseline/consolidation/balanced.js` has good deduplication rules but is missing the curation sections that make the orchestration prompt aggressive about reducing output:
- **No "Priority-Based Curation"** — orchestration explicitly orders severity tiers and discards low-value items. Consolidation just says "Quality over quantity" in a single bullet.
- **No "Balanced Output"** — orchestration caps praise at 2–3 items, warns against suggestion overload. Consolidation has no equivalent.
- **Summary instruction is passive**: `"Draw on reviewer summaries for high-level conclusions"` — the AI interprets "draw on" as "quote from", producing a concatenation or slight paraphrase rather than a synthesis.

The `fast.js` and `thorough.js` variants have the same structural gaps.

### 3. Summary extraction bug in `_crossVoiceConsolidate` (`analyzer.js:3873`)

```js
const summary = response.summary || `Consolidated ${voiceReviews.length} reviewer outputs into ${suggestions.length} suggestions`;
```

When a provider returns `response.raw` (raw text) rather than pre-parsed JSON, `response.summary` is `undefined` and the generic fallback is always used. Compare with `orchestrateWithAI` (lines 2601–2607) which has an explicit `response.raw → extractJSON() → extracted.data.summary` path. `_crossVoiceConsolidate` never extracts the summary from raw output.

---

## Approach

Three targeted fixes, applied in dependency order:

**Fix 1 (code):** Remove the below-threshold skip from `runReviewerCentricCouncil`. For the reviewer-centric council path, consolidation is the entire purpose of running multiple reviewers. The cost of one extra AI call is always worth it. Keep `COUNCIL_CONSOLIDATION_THRESHOLD` for `runCouncilAnalysis` (line 3412) — that path has different tradeoffs and is out of scope.

**Fix 2 (code):** Add `response.raw` summary extraction to `_crossVoiceConsolidate`, matching the pattern already in `orchestrateWithAI`.

**Fix 3 (prompts):** Add `priority-curation` and `balanced-output` sections to all three consolidation tier prompts. Rewrite the summary field description to use active synthesis language. This is a prompt content change, not a structural change to the prompt system.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/ai/analyzer.js` | Remove lines 3098–3123 (below-threshold skip); fix summary extraction in `_crossVoiceConsolidate` |
| `src/ai/prompts/baseline/consolidation/balanced.js` | Add `priority-curation` + `balanced-output` sections; fix summary instruction |
| `src/ai/prompts/baseline/consolidation/fast.js` | Same additions (abbreviated form to match tier style) |
| `src/ai/prompts/baseline/consolidation/thorough.js` | Same additions (expanded form to match tier style) |
| `scripts/generate-skill-prompts.js` | **Run** (do not modify) — regenerates static reference files per CLAUDE.md |

---

## Implementation Steps

### Step 1 — Remove the below-threshold skip from `runReviewerCentricCouncil`

Delete lines 3098–3123 entirely:

```js
// DELETE this entire block:
if (totalSuggestionCount < COUNCIL_CONSOLIDATION_THRESHOLD) {
  logger.info(`[ReviewerCouncil] ${totalSuggestionCount} total suggestions below threshold...`);
  const summary = voiceSummaries.length > 1 ? voiceSummaries.join('\n\n') : voiceSummaries[0];
  // ... validateAndFinalizeSuggestions, storeSuggestions, analysisRunRepo.update, return
}
```

The code that follows (starting at line 3126 "Run cross-reviewer consolidation") already handles the N-voice case correctly. The single-voice shortcut (lines 3067–3093) stays — that one is correct and avoids an unnecessary consolidation call.

Also remove the unused `voiceSummaries` array (line 3040) and the `.push(settled.value.result.summary)` inside the loop (line 3048) since they were only used in the deleted block — *unless* `voiceSummaries` is referenced elsewhere below the deleted block. Check before deleting.

### Step 2 — Fix summary extraction in `_crossVoiceConsolidate`

Replace the current one-liner (line 3873) with the same pattern used in `orchestrateWithAI`:

```js
// Before:
const summary = response.summary || `Consolidated ${voiceReviews.length} reviewer outputs into ${suggestions.length} suggestions`;

// After:
let summary = `Consolidated ${voiceReviews.length} reviewer outputs into ${suggestions.length} suggestions`;
if (response.summary) {
  summary = response.summary;
} else if (response.raw) {
  const extracted = extractJSON(response.raw, 'consolidation');
  if (extracted.success && extracted.data.summary) {
    summary = extracted.data.summary;
  }
}
```

`extractJSON` is already imported at line 11 and used in `orchestrateWithAI` — no new import needed.

### Step 3 — Strengthen the consolidation prompts

**`balanced.js`** — add two new sections between `consensus-handling` and `output-schema`. Also update the summary field description inside `output-schema`.

New `priority-curation` section (insert after `consensus-handling`):
```
<section name="priority-curation" required="true">
### 7. Priority-Based Curation
When multiple reviewers flag the same category of issues, prioritize in this order:
1. **Security vulnerabilities** — Critical safety issues
2. **Bugs and errors** — Functional correctness issues
3. **Architecture concerns** — Design and structural issues
4. **Performance optimizations** — Efficiency improvements
5. **Code style** — Formatting and convention issues
</section>
```

New `balanced-output` section (insert after `priority-curation`):
```
<section name="balanced-output" required="true">
### 8. Balanced Output
- **Reduce, don't aggregate**: Your output should contain *fewer* suggestions than the total input. If two reviewers flagged the same issue, it becomes one suggestion — not two.
- **Limit praise** to 2–3 most noteworthy items across all reviewers
- **Avoid suggestion overload** — aim for quality over quantity
- **Include confidence scores** reflecting cross-reviewer agreement
</section>
```

In the `output-schema` section, change the `summary` field description from:
```
"summary": "Brief consolidation summary. Draw on reviewer summaries for high-level conclusions. Write as if a single reviewer..."
```
to:
```
"summary": "Synthesize the key findings into a single cohesive paragraph. Do not list or quote individual reviewer summaries — draw your own conclusion from the evidence. Write as if a single reviewer produced this analysis — do not mention 'consolidation', 'merging', or 'multiple reviewers'."
```

Update `sections` array and `defaultOrder` array in the same file to include the two new section names.

**`fast.js`** — add abbreviated equivalents matching the terse style of that file:
- `priority-curation`: one-liner "Prioritize: security > bugs > architecture > performance > style."
- `balanced-output`: "Output should have FEWER suggestions than input total. Max 2 praise items. Reduce, don't aggregate."
- Same summary field fix.

**`thorough.js`** — add fuller versions matching its expanded style. The thorough tier already has a `summary-synthesis-guidance` section; align the summary instruction there as well.

### Step 4 — Regenerate skill prompt reference files

Per CLAUDE.md: after modifying prompts, run:
```
node scripts/generate-skill-prompts.js
```

---

## Edge Cases & Risks

- **`COUNCIL_CONSOLIDATION_THRESHOLD` still used at line 3412** (`runCouncilAnalysis`). Do not remove the constant — only remove the one call site in `runReviewerCentricCouncil`. If the constant becomes `runCouncilAnalysis`-only, rename it in a separate commit to avoid confusion.

- **`voiceSummaries` reference check**: After deleting the below-threshold block, scan downward for any remaining use of `voiceSummaries`. Line 3176 builds the final summary as `consolidated.summary || fallback` — it does not use `voiceSummaries`, so that array and its `.push()` call can be deleted. But verify by search before deleting.

- **Fallback still concatenates on error**: The catch block at lines 3196–3223 still falls back to `allVoiceSuggestions` (concatenation) when `_crossVoiceConsolidate` throws. This is acceptable — it's the last-resort failure path. Do not change it.

- **Prompt token cost increases**: Adding two sections to the consolidation prompt increases input tokens for every consolidation call. Acceptable — the sections are short and the improvement is significant. The fast tier should keep its additions minimal (single lines, no examples).

- **`balanced-output` framing risk**: Don't frame the output reduction as a hard cap ("produce no more than N suggestions"). That could cause the AI to silently drop a batch of critical bugs to meet an artificial limit. Frame it as guidance, not a constraint — "reduce, don't aggregate" captures the intent without creating a ceiling.

- **`_intraLevelConsolidate` has the same summary discard bug** (line 3702: `return this.parseResponse(response, level)` drops `response.summary`). The level-centric council path doesn't surface summaries per level today, so this is lower priority, but flag it in a comment or add to a follow-up issue.

---

## Testing Strategy

**Unit tests — `tests/unit/analyzer-consolidation.test.js` (existing file, extend it)**

1. **Below-threshold removal** (source verification pattern already established in that file):
   - Assert the `runReviewerCentricCouncil` method body does NOT contain the string `COUNCIL_CONSOLIDATION_THRESHOLD` (meaning the skip block was removed)
   - Assert it still contains a single-voice shortcut check (`successfulVoices.length === 1`)

2. **`_crossVoiceConsolidate` summary extraction**:
   - Extract the method body via regex (same pattern as existing tests)
   - Assert it contains `response.raw` and `extractJSON` (the raw extraction path)
   - Assert it does NOT use the old one-liner pattern `response.summary ||` directly on the `const summary =` line without fallback logic

3. **Prompt section presence**:
   - In a new describe block, import the consolidation prompt files directly and assert `sections` arrays include `priority-curation` and `balanced-output`

**Unit tests — new file or `tests/unit/consolidation-prompt.test.js`**

- Verify `parseSections()` in `balanced.js` returns sections with the expected names and `required: true` for the new sections
- Same for `fast.js` and `thorough.js`
- Assert the summary field description in `output-schema` section contains "Synthesize" and does not contain "Draw on reviewer summaries"

**Manual verification**

- Run a council with 2 reviewers on a PR that has clear duplicate findings (e.g., same typo flagged by both)
- Confirm the consolidated output does not double-count the finding
- Confirm the summary is a single synthesized paragraph, not two joined with `\n\n`
- Check logs: you should see `[ReviewerCouncil] Starting cross-reviewer consolidation` even for small PRs (≥2 successful voices)

