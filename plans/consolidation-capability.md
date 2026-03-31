# Add `consolidation` capability to providers

## Context

Executable providers can be used for review analysis but may not support consolidation (merging multiple reviewers' findings into a coherent result). Currently, the consolidation provider dropdown in the Council/Advanced config dialogs shows *all* available providers, including those that can't perform consolidation. The backend already skips executable providers when choosing a *default* consolidation provider (`_defaultConsolidation` in analyzer.js:3868), but users can still manually select an incapable provider from the dropdown.

We need a `consolidation` capability flag so that:
1. Built-in providers default to `consolidation: true`
2. Executable providers default to `consolidation: false` (configurable to `true`)
3. The consolidation provider dropdowns in both VoiceCentricConfigTab and AdvancedConfigTab filter out providers where `consolidation` is `false`

## Changes

### 1. Backend: Add `consolidation` capability

**`src/ai/executable-provider.js`** (~line 526)
- Add `consolidation` to the capabilities object, defaulting to `false`:
```js
ExecProvider.capabilities = {
  review_levels: caps.review_levels !== undefined ? caps.review_levels : false,
  custom_instructions: caps.custom_instructions !== undefined ? caps.custom_instructions : false,
  consolidation: caps.consolidation !== undefined ? caps.consolidation : false
};
```
- Update the JSDoc `@param` for `config.capabilities` to document the new field.

**`src/ai/provider.js`** (~line 622)
- Add `consolidation: true` to the default capabilities for built-in providers:
```js
const capabilities = ProviderClass.capabilities || {
  review_levels: true,
  custom_instructions: true,
  consolidation: true
};
```

### 2. Frontend: Filter consolidation dropdown

Both `VoiceCentricConfigTab.js` and `AdvancedConfigTab.js` use `_populateProviderDropdown(select)` for *all* provider dropdowns (voices and consolidation). The consolidation dropdown is identified by `data-target="orchestration"` on the `<select>`.

**`public/js/components/VoiceCentricConfigTab.js`** (~line 771)
**`public/js/components/AdvancedConfigTab.js`** (~line 706)

In `_populateProviderDropdown`, add filtering when the select is for consolidation:

```js
_populateProviderDropdown(select) {
  const currentValue = select.value;
  const isConsolidation = select.dataset.target === 'orchestration';
  select.innerHTML = '';
  const providerIds = Object.keys(this.providers).filter(id => {
    const p = this.providers[id];
    if (p.availability && !p.availability.available) return false;
    if (isConsolidation && p.capabilities?.consolidation === false) return false;
    return true;
  }).sort((a, b) => (this.providers[a].name || a).localeCompare(this.providers[b].name || b));
  // ... rest unchanged
}
```

### 3. Config example

**`config.example.json`** (~line 203)
- Add `consolidation: false` to the example capabilities block so users know it's configurable.

### 4. Tests

**`tests/unit/provider-config.test.js`**
- Update existing capability assertions to include `consolidation: true` for built-in providers and `consolidation: false` for unconfigured executable providers.
- Add test for executable provider with `consolidation: true` explicitly set.

**`tests/unit/executable-provider.test.js`**
- Update capability assertions to include the new `consolidation` field.

**`tests/unit/voice-centric-config-tab.test.js`** and/or **`tests/unit/advanced-config-tab.test.js`** (if they exist)
- Add test that the consolidation dropdown excludes providers with `consolidation: false`.

## Hazards

- `_populateProviderDropdown` is called for ALL `<select class="voice-provider">` elements — both voice rows and the consolidation row. The `data-target="orchestration"` check must be precise to avoid accidentally filtering voice dropdowns.
- The `_defaultConsolidation()` and `_defaultOrchestration()` methods in `analyzer.js` already skip executable providers using `isExecutable`. They don't need changes since they select from *voices* not from the full provider list, but they should remain consistent with the new capability.
- Both `VoiceCentricConfigTab` and `AdvancedConfigTab` have independent copies of `_populateProviderDropdown` — both must be updated.

## Verification

1. `npm test` — all unit/integration tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: configure an executable provider without `consolidation: true`, open council dialog, verify it doesn't appear in the consolidation dropdown but does appear in voice dropdowns
