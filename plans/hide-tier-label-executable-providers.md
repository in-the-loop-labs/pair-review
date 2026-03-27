# Hide Tier Label for Executable Providers in Progress Dialog

## Context

The analysis progress dialog shows tier text (e.g., "Balanced", "Thorough") next to every provider name via labels like `Claude sonnet-4-5 (Balanced)`. For executable providers (e.g., Binks), the tier is meaningless — it controls which pair-review prompt template is used, and executable providers ignore it entirely. Displaying it is misleading.

## Changes

### 1. Update `_formatVoiceLabel` to accept an `isExecutable` flag

**File**: `public/js/components/CouncilProgressModal.js` (line 1623)

Current:
```js
_formatVoiceLabel(voice) {
  const provider = this._capitalize(voice.provider || 'unknown');
  const model = voice.model || 'default';
  const tier = this._capitalize(voice.tier || 'balanced');
  return `${provider} ${model} (${tier})`;
}
```

Change to:
```js
_formatVoiceLabel(voice, { isExecutable = false } = {}) {
  const provider = this._capitalize(voice.provider || 'unknown');
  const model = voice.model || 'default';
  if (isExecutable) return `${provider} ${model}`;
  const tier = this._capitalize(voice.tier || 'balanced');
  return `${provider} ${model} (${tier})`;
}
```

### 2. Pass `isExecutable` at the voice-centric call site

**File**: `public/js/components/CouncilProgressModal.js` (line 1265)

This call site already computes `isExecutable` on line 1266. Reorder so we compute it first, then pass it:

```js
const isExecutable = this._executableVoices.has(voiceKey) || (providersMap[voice.provider]?.isExecutable || false);
const label = this._formatVoiceLabel(voice, { isExecutable });
```

### 3. Level-centric call site — no change needed

**File**: `public/js/components/CouncilProgressModal.js` (line 1500)

In `_buildActiveLevel`, executable providers never appear (they don't have L1/L2/L3 levels), so the existing call without `isExecutable` is correct — it defaults to `false`.

### 4. Add unit tests for `_formatVoiceLabel`

**File**: `tests/unit/council-progress-modal.test.js`

Add tests for:
- Regular provider: includes tier in parentheses
- Executable provider: omits tier suffix
- Default tier fallback when `voice.tier` is undefined

## Hazards

- `_formatVoiceLabel` has exactly two callers: `_rebuildBodyVoiceCentric` (line 1265) and `_buildActiveLevel` (line 1500). Only the voice-centric caller needs the change.
- The `isExecutable` computation at line 1266 must be moved *above* the `_formatVoiceLabel` call at line 1265.

## Verification

1. Run unit tests: `npm test -- tests/unit/council-progress-modal.test.js`
2. Manual: start a council analysis with an executable provider voice — confirm its progress label shows `ProviderName model` without `(Tier)` suffix, while native providers still show `(Balanced)` etc.
