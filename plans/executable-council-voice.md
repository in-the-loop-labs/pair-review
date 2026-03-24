# Plan: Executable Providers as Council Voices

## Context

Executable providers (black-box external CLI tools) currently run only as standalone analyzers. Council mode runs multiple AI providers ("voices") in parallel, then consolidates their results. We want executable providers to participate as council voices, with their single-run output treated as equivalent to a native voice's fully consolidated L1/L2/L3 result.

No new capability flags needed — any provider that can run standalone can be a council voice. `capabilities.review_levels: false` already excludes executable providers from advanced (level-centric) mode.

## Changes Summary

| Change | Files |
|--------|-------|
| Detect executable voices, run via dedicated path | `src/ai/analyzer.js` |
| Helper: `runExecutableVoice()` | `src/ai/analyzer.js` |
| Default consolidation: skip executable providers | `src/ai/analyzer.js` |
| Annotate executable voices in consolidation prompt | `src/ai/analyzer.js` |
| Council validation: relax level requirement for all-executable | `src/routes/councils.js` |
| Progress modal: single row for executable voices | `public/js/components/CouncilProgressModal.js` |
| Voice config UI: hide tier for executable voices | `public/js/components/VoiceCentricConfigTab.js` |
| Tests | `tests/unit/analyzer.test.js`, `tests/unit/councils.test.js` |

---

## 1. `src/ai/analyzer.js` — `buildVoiceContext()`

Lines 83-109. Add executable detection and provider instance.

```js
// Add import at top (line 2):
const { createProvider, getProviderClass } = require('./index');

function buildVoiceContext(voice, idx, instructions, progressCallback, db) {
  // ... existing voiceKey, reviewerLabel, voiceRequestInstructions logic ...

  const ProviderClass = getProviderClass(voice.provider);
  const isExecutable = ProviderClass?.isExecutable || false;

  // Only create Analyzer for native voices
  const voiceAnalyzer = isExecutable ? null : new Analyzer(db, voice.model, voice.provider);
  // Create provider instance for executable voices (used directly)
  const voiceProvider = isExecutable ? createProvider(voice.provider, voice.model) : null;

  // ... existing voiceTier, voiceTimeout, voiceProgressCallback ...

  return {
    voiceAnalyzer, voiceProvider, isExecutable,
    voiceKey, reviewerLabel, voiceRequestInstructions,
    voiceProgressCallback, voiceTier, voiceTimeout
  };
}
```

---

## 2. `src/ai/analyzer.js` — New helper: `runExecutableVoice()`

Add as module-level function near `buildVoiceContext`. Mirrors the pattern in `src/routes/executable-analysis.js` but without Express/HTTP concerns.

```js
const os = require('os'); // add to imports

async function runExecutableVoice(voiceProvider, reviewId, worktreePath, prMetadata, options) {
  const { analysisId, timeout, requestInstructions, progressCallback, logPrefix } = options;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-exec-'));
  try {
    const executableContext = {
      title: prMetadata.title || '',
      description: prMetadata.description || '',
      cwd: worktreePath,
      outputDir: tmpDir,
      baseBranch: prMetadata.base_branch || null,
    };

    const result = await voiceProvider.execute(null, {
      executableContext,
      cwd: worktreePath,
      timeout: voiceProvider.timeout || timeout || 600000,
      analysisId,
      registerProcess,
      onStreamEvent: progressCallback ? (event) => {
        progressCallback({ level: 'exec', status: 'running', streamEvent: event });
      } : null
    });

    if (!result?.success || !result?.data) {
      throw new Error(`${logPrefix || ''}Executable provider returned no data`);
    }

    return {
      suggestions: result.data.suggestions || [],
      summary: result.data.summary || ''
    };
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
```

Note: `registerProcess` is already imported at line 21.

---

## 3. `src/ai/analyzer.js` — `runReviewerCentricCouncil()` voice execution

### Single-voice path (lines 2751-2793)

After `buildVoiceContext`, branch on `isExecutable`:

```js
if (isExecutable) {
  const result = await runExecutableVoice(voiceProvider, reviewId, worktreePath, prMetadata, {
    analysisId, timeout: voiceTimeout,
    requestInstructions: voiceRequestInstructions,
    progressCallback: voiceProgressCallback,
    logPrefix: `[${reviewerLabel}] `
  });
  // Store suggestions on parent run (same as native single-voice path)
  const finalSuggestions = this.validateAndFinalizeSuggestions(result.suggestions, fileLineCountMap, validFiles);
  await this.storeSuggestions(reviewId, parentRunId, finalSuggestions, null, validFiles);
  // ... update parent run, return result (mirror existing lines 2939-2959)
} else {
  // ... existing analyzeAllLevels path
}
```

### Multi-voice path (lines 2816-2887)

Inside `voicePromises.map`, after `buildVoiceContext` and child run creation, branch:

```js
if (isExecutable) {
  const result = await runExecutableVoice(voiceProvider, reviewId, worktreePath, prMetadata, {
    analysisId, timeout: voiceTimeout,
    requestInstructions: voiceRequestInstructions,
    progressCallback: voiceProgressCallback,
    logPrefix: `[${reviewerLabel}] `
  });
  // Update child run
  await analysisRunRepo.update(childRunId, { status: 'completed', summary: result.summary, totalSuggestions: result.suggestions?.length || 0 });
  // Store raw voice suggestions
  await commentRepo.bulkInsertAISuggestions(reviewId, childRunId, result.suggestions, null);
  return { voiceKey, reviewerLabel, childRunId, result, provider: voice.provider, model: voice.model, isExecutable: true };
} else {
  // ... existing analyzeAllLevels path (add isExecutable: false to return)
}
```

### Voice-init progress (lines 2758-2765 and 2797-2813)

Add `isExecutable` flag to voice init data so the frontend can render appropriately:

```js
voices: Object.fromEntries(voices.map((v, idx) => {
  const ProviderClass = getProviderClass(v.provider);
  return [voiceKey, {
    status: 'pending', provider: v.provider, model: v.model,
    tier: v.tier || 'balanced',
    isExecutable: ProviderClass?.isExecutable || false
  }];
}))
```

---

## 4. `src/ai/analyzer.js` — `_defaultConsolidation()`

Lines 3642-3653. Skip executable providers when picking default consolidation voice:

```js
_defaultConsolidation(councilConfig) {
  const voices = councilConfig.voices || [];
  // Prefer first non-executable voice for consolidation
  const nativeVoice = voices.find(v => !getProviderClass(v.provider)?.isExecutable);
  if (nativeVoice) {
    return { provider: nativeVoice.provider, model: nativeVoice.model, tier: nativeVoice.tier || 'balanced' };
  }
  // All-executable council: fall back to user's default provider
  if (voices.length > 0) {
    return { provider: 'claude', model: 'sonnet-4.6', tier: 'balanced' };
  }
  return { provider: 'claude', model: 'sonnet-4.6', tier: 'balanced' };
}
```

---

## 5. `src/ai/analyzer.js` — `_crossVoiceConsolidate()`

Lines 3020-3028. Pass `isExecutable` through to consolidation so the prompt can annotate:

```js
const voiceReviews = successfulVoices.map(v => ({
  voiceKey: v.voiceKey,
  provider: v.provider, model: v.model,
  isExecutable: v.isExecutable || false,
  // ... rest unchanged
}));
```

In the consolidation prompt builder (inside `_crossVoiceConsolidate`, ~line 3673), annotate executable voices:

```js
let desc = `### Reviewer: ${v.voiceKey}`;
if (v.isExecutable) desc += ' [external tool]';
```

---

## 6. `src/routes/councils.js` — Validation

In `validateCouncilFormat()` (~line 133), relax the level requirement when all voices are executable:

```js
const allExecutable = config.voices.every(v => {
  const ProviderClass = getProviderClass(v.provider);
  return ProviderClass?.isExecutable;
});

if (!allExecutable) {
  // existing level check
  const hasEnabled = Object.entries(config.levels).some(...);
  if (!hasEnabled) return 'At least one level must be enabled for non-executable providers';
}
```

Import `getProviderClass` from `../ai/provider`.

---

## 7. `public/js/components/CouncilProgressModal.js` — Executable voice progress

In `_rebuildBodyVoiceCentric()` (~line 1110), when building the tree for each voice, check `isExecutable` from the voice init data. For executable voices, render a single "Running analysis..." row instead of L1/L2/L3 + consolidation children:

```html
<!-- Executable voice child -->
<div class="council-vc-level" data-vc-voice="${voiceKey}" data-vc-level="exec">
  <span class="council-vc-level-icon pending">○</span>
  <span class="council-vc-level-title">Running analysis...</span>
  <span class="council-vc-level-status pending">Pending</span>
  <div class="council-level-snippet" style="display: none;"></div>
</div>
```

In `_updateVoiceCentric()` (~line 577), handle `level === 'exec'` updates for executable voices — update the single row's state and show stream event text in the snippet element.

---

## 8. `public/js/components/VoiceCentricConfigTab.js` — Voice config UI

In the voice row provider change handler, detect `isExecutable` from the providers list and:
- Hide the tier dropdown for executable providers (they run as-is)
- Show a note: "External tool — runs its own analysis pipeline"

Add `_updateLevelToggleState()` called after any voice add/remove/change:
- If all voices are executable, disable level checkboxes with note
- If any native voice present, re-enable

---

## Hazards

- `buildVoiceContext` has two callers: single-voice path (line 2753) and multi-voice path (line 2817). Both must handle `isExecutable` branching.
- `_defaultConsolidation` (line 3005): if first voice is executable, using it for consolidation would fail. Fix picks first native voice.
- Temp directory lifecycle in `runExecutableVoice` must be cleaned up in all error/cancellation paths. The `finally` block handles this.
- Progress `level: 'exec'` is a new synthetic level value. Frontend must handle it in `_updateVoiceCentric` without breaking numeric level handling.
- `registerProcess` is already imported in analyzer.js (line 21) — reuse for executable voice cancellation.

---

## Verification

1. **Unit tests**: `npm test -- tests/unit/analyzer.test.js` — test `runExecutableVoice` and the branching logic
2. **Unit tests**: `npm test -- tests/unit/councils.test.js` — test validation relaxation for all-executable councils
3. **Full suite**: `npm test`
4. **E2E**: `npm run test:e2e`
5. **Manual**: Configure a council with 1 native + 1 executable voice, run analysis, verify:
   - Both voices execute in parallel
   - Progress modal shows L1/L2/L3 for native and single row for executable
   - Cross-voice consolidation produces merged results
   - All-executable council works without levels configured
