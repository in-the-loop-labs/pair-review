# Per-Reviewer Context in Consolidation Prompts

## Context

Council consolidation currently receives reviewer suggestions as a flat formatted list. While `_crossVoiceConsolidate` does label each reviewer with a `### Reviewer:` header (provider/model), two key pieces of context are missing:

1. **Per-reviewer custom instructions** — a reviewer configured with "Focus on security vulnerabilities" produces security-weighted findings, but the consolidator has no way to know this. It may incorrectly de-prioritize specialty findings or fail to weight them appropriately during conflict resolution.
2. **Prompt guidance on using reviewer context** — even with the data present, the consolidation prompt has no guidance on how to weight specialty vs. generalist reviewers.

This affects both consolidation paths:
- `_crossVoiceConsolidate` (reviewer-centric council) — already has per-reviewer structure, just needs custom instructions added
- `_intraLevelConsolidate` (level-centric council) — receives a flat suggestion array with no per-reviewer grouping at all

## Hazards

- `_crossVoiceConsolidate` has **one caller** (line 3160 in `runReviewerCentricCouncil`). Safe to change the `voiceReviews` shape.
- `_intraLevelConsolidate` has **one caller** (line 3474 in `runCouncilAnalysis`). Signature change is safe but tests at `tests/unit/analyzer-consolidation.test.js` use regex to match the method signature.
- `voiceTasks[i].customInstructions` in `runCouncilAnalysis` is the **merged** version (global + repo + request + voice-specific). For consolidation, we only want the **voice-specific** part, since global/repo/request instructions already appear in the prompt's `{{customInstructions}}` section. Must preserve `voice.customInstructions` as a separate field.
- The `input-suggestions` section is marked `locked` in all consolidation templates, but the restructured content flows through the same `{{reviewerSuggestions}}` placeholder — no template structure change needed for that section.

## Changes

### 1. Thread `customInstructions` through voice promise returns (`analyzer.js`)

Add `customInstructions: voice.customInstructions || null` to both return objects in `runReviewerCentricCouncil`:
- **Line 2970** (executable provider return)
- **Line 3004** (native provider return)

The `voice` object is already in scope at both locations.

### 2. Include `customInstructions` in `voiceReviews` assembly (`analyzer.js:3149`)

Add `customInstructions: v.customInstructions || null` to the `voiceReviews.map()` call.

### 3. Enrich `voiceDescriptions` in `_crossVoiceConsolidate` (`analyzer.js:3805`)

Update the formatting block to include custom instructions and better structure:

```javascript
const voiceDescriptions = voiceReviews.map(v => {
  let desc = `### Reviewer: ${v.voiceKey}`;
  if (v.isExecutable) desc += ' [external tool]';
  desc += ` (${v.provider}/${v.model}) — ${v.suggestionCount} suggestions\n`;
  if (v.customInstructions) {
    desc += `\n**Review Focus:**\n${v.customInstructions}\n`;
  }
  if (v.summary) desc += `\n**Summary:** ${v.summary}\n`;
  desc += `\n**Suggestions:**\n${JSON.stringify(v.suggestions, null, 2)}`;
  if (v.fileLevelSuggestions?.length > 0) {
    desc += `\n**File-Level Suggestions:**\n${JSON.stringify(v.fileLevelSuggestions, null, 2)}`;
  }
  return desc;
}).join('\n\n---\n\n');
```

### 4. Restructure `_intraLevelConsolidate` for per-reviewer grouping (`analyzer.js`)

**4a. Add `voiceCustomInstructions` to `voiceTasks` (~line 3267-3300):**

Preserve the voice-only custom instructions separately from the merged version:
```javascript
voiceTasks.push({
  ...existing fields,
  customInstructions: voiceInstructions,           // merged (for running analysis)
  voiceCustomInstructions: voice.customInstructions || null  // voice-only (for consolidation)
});
```

**4b. Change call site (~line 3474):**

Build per-reviewer groups from `voiceTasks` + `voiceResults` instead of passing flat `levelSuggestions[level]`:

```javascript
const voiceGroups = voiceTasks
  .map((task, idx) => ({ task, result: voiceResults[idx] }))
  .filter(({ task, result }) => task.level === level && result.status === 'fulfilled')
  .map(({ task, result }) => ({
    voiceId: task.voiceId,
    provider: task.provider,
    model: task.model,
    customInstructions: task.voiceCustomInstructions,
    suggestions: result.value.suggestions
  }));
```

**4c. Change method signature:**
```javascript
async _intraLevelConsolidate(level, voiceGroups, prMetadata, customInstructions, worktreePath, orchConfig)
```

**4d. Format per-reviewer blocks inside the method:**
```javascript
const reviewerSuggestions = voiceGroups.map(g => {
  let desc = `### Reviewer: ${g.voiceId} (${g.provider}/${g.model})\n`;
  if (g.customInstructions) {
    desc += `\n**Review Focus:**\n${g.customInstructions}\n`;
  }
  desc += `\n**Suggestions:**\n${JSON.stringify(g.suggestions, null, 2)}`;
  return desc;
}).join('\n\n---\n\n');
```

Use `reviewerSuggestions` instead of `JSON.stringify(suggestions, null, 2)` in the `promptBuilder.build()` call. Update `suggestionCount` and `reviewerCount` accordingly.

### 5. Add reviewer-context guidance to consolidation prompt templates

Add a new `reviewer-context-guidance` section before `input-suggestions` in all three tiers.

**Thorough** (`consolidation/thorough.js`):
```
<section name="reviewer-context-guidance" required="true">
### Reviewer Context Awareness
Each reviewer below may have been configured with specific focus areas or custom instructions. When present, use these to interpret and weight their suggestions:

- **Specialized reviewers** (those with custom instructions): Their findings in their specialty area carry higher weight than generalist reviewers flagging the same category
- **General reviewers** (no custom instructions): Treat their suggestions at face value across all categories
- **Cross-specialty findings**: When a specialized reviewer flags something outside their focus area, treat it as a general finding — don't boost or penalize
- **Conflict resolution**: When a specialized reviewer disagrees with a generalist on the specialist's focus area, prefer the specialist's analysis
</section>
```

**Balanced** (`consolidation/balanced.js`):
Same content as thorough (this section isn't long enough to warrant compression).

**Fast** (`consolidation/fast.js`):
```
<section name="reviewer-context-guidance" required="true" tier="fast">
### Reviewer Context
Reviewers may have focus areas noted below. Weight specialty findings higher. In conflicts, prefer specialist over generalist in the specialist's domain.
</section>
```

### 6. Update tests (`tests/unit/analyzer-consolidation.test.js`)

- Update `_intraLevelConsolidate` signature regex for the new `voiceGroups` parameter
- Add test: `voiceReviews` includes `customInstructions` field
- Add test: `_crossVoiceConsolidate` voiceDescriptions includes `customInstructions`
- Add test: consolidation templates contain `reviewer-context-guidance` section

### 7. Regenerate skill reference files

Run `node scripts/generate-skill-prompts.js` — the consolidation templates aren't currently in the reference set (only level + orchestration), but run it to be safe.

## Files to Modify

| File | Change |
|------|--------|
| `src/ai/analyzer.js` | Steps 1-4: thread custom instructions, restructure both consolidation paths |
| `src/ai/prompts/baseline/consolidation/thorough.js` | Step 5: add reviewer-context-guidance section |
| `src/ai/prompts/baseline/consolidation/balanced.js` | Step 5: add reviewer-context-guidance section |
| `src/ai/prompts/baseline/consolidation/fast.js` | Step 5: add reviewer-context-guidance section |
| `tests/unit/analyzer-consolidation.test.js` | Step 6: update and add tests |

## Verification

1. `npm test -- --run tests/unit/prompts` — prompt template tests pass
2. `npm test -- --run tests/unit/analyzer-consolidation` — consolidation tests pass
3. Manual: run a council analysis with 2+ reviewers (one with custom instructions) and verify the consolidation prompt includes per-reviewer sections with focus areas
