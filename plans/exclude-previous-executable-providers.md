# Add `exclude_previous` Capability for Executable Providers

## Context

The "Exclude Previous Findings" section in the AnalysisConfigModal lets users skip issues already noted in GitHub PR comments or previous pair-review feedback. Executable providers may not support this feature (they run their own analysis pipeline). We need a capability flag to gate the UI, and visually disable the entire section when the selected provider cannot honour it — without altering persisted checkbox state.

The exclude-previous section is **hoisted outside all tab panels** so it's visible on every tab. It must be disabled only when on the Single Model tab with a non-capable provider, and re-enabled when switching to Council/Advanced tabs (where orchestration handles dedup regardless of reviewer capabilities).

## Hazards

- `selectProvider()` has 4 callers (lines 486, 510, 935, 938). The new `_updateExcludePreviousState()` call at the end must not break any.
- `_restoreExcludePrevious()` (line 969) runs AFTER `selectProvider()` (line 935) in the show flow. The section-level disable must not interfere with checkbox restore or the no-token GitHub disable logic — since we never touch individual checkboxes, this is safe.

## Design Principle

Disable the **entire `<details>` section** as a visual indicator. Never modify individual checkbox `checked` or `disabled` state for this capability. The persisted localStorage state is untouched. On submit, simply omit `excludePrevious` when the capability is `false`.

## Changes

### 1. Backend — Add capability flag

**`src/ai/executable-provider.js`** (line 526-529): Add `exclude_previous`:
```javascript
exclude_previous: caps.exclude_previous !== undefined ? caps.exclude_previous : false
```

**`src/ai/provider.js`** (line 622-625): Add `exclude_previous: true` to built-in defaults.

**`config.example.json`** (line 203-206): Add `"exclude_previous": false` to example.

### 2. Frontend — New `_updateExcludePreviousState()` method

**`public/js/components/AnalysisConfigModal.js`**: Add after `_getAndSaveExcludePrevious()`:

- If `activeTab === 'single'` AND selected provider's `exclude_previous === false`:
  - Add class `exclude-previous-disabled` to the `<details>` element
  - Close the `<details>` (remove `open` attribute) so it collapses
  - Inject `.executable-provider-note.executable-provider-exclude-note` after the `<summary>` (before the options div)
- Otherwise:
  - Remove the class and note
  - Do NOT re-open the `<details>` (leave that to the user)

No checkbox state is modified. The section is simply made inert and visually muted.

### 3. Frontend — Wire up the helper

**`selectProvider()`** — call `_updateExcludePreviousState()` after line 618.

**`_switchTab()`** — call `_updateExcludePreviousState()` after the dirty hint logic (after line 1153).

**`handleSubmit()`** — single model path (line 830): when `exclude_previous === false`, set `excludePrevious: undefined` instead of calling `_getAndSaveExcludePrevious()`.

### 4. CSS

**`public/css/analysis-config.css`**: Add disabled state for the section:

```css
/* Section disabled by provider capability */
.exclude-previous-section.exclude-previous-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.exclude-previous-section .executable-provider-note {
  margin: 8px 14px;
  pointer-events: auto;
}
```

`pointer-events: none` prevents opening the `<details>` or interacting with checkboxes. The note gets `pointer-events: auto` so the text is selectable.

### 5. Tests

**`tests/unit/executable-provider.test.js`** (lines 169-182): Update all capability assertions to include `exclude_previous`:
- Full caps: `{ review_levels: true, custom_instructions: true, exclude_previous: true }`
- Partial: `{ review_levels: true }` → defaults others to `false`
- None: all three default to `false`
- Add case: `{ exclude_previous: true }` alone

## Files Modified

- `src/ai/executable-provider.js` — add capability
- `src/ai/provider.js` — add default capability
- `config.example.json` — add to example
- `public/js/components/AnalysisConfigModal.js` — new helper, wire into selectProvider/switchTab/handleSubmit
- `public/css/analysis-config.css` — disabled section styling
- `tests/unit/executable-provider.test.js` — update assertions

## Verification

1. `npm test` — unit tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: select executable provider on Single Model tab → section collapses, grayed out with note. Switch to Council → section re-enabled. Switch back → disabled again. Submit → no `excludePrevious` in request.
