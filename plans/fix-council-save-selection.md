# Fix: Council not selected after save

## Context

When a user saves a council in the Analysis Config dialog (either "Save" on an existing council or "Save As" for a new one), the saved council is not selected in the dropdown afterward — the selector reverts to "+ New Council".

**Root cause**: `_putCouncil()` (Save existing) does NOT explicitly update the selector after `loadCouncils()` rebuilds the dropdown. It relies on `_renderCouncilSelector()`'s `currentValue` restoration, which is fragile — the `innerHTML` wipe clears all options and resets the selector value to `""`, and the restoration via `selector.value = currentValue` can fail if the captured value doesn't match for any reason.

By contrast, `_postCouncil()` (Save As) already has explicit selector-update code after `loadCouncils()`, so it should work — though it's worth confirming. The user reports both flows are broken, but the PUT flow has a clear code deficiency.

## Files to modify

1. **`public/js/components/VoiceCentricConfigTab.js`** (lines 1327-1338)
   - Add explicit selector update after `await this.loadCouncils()` in `_putCouncil()`
   - Match the pattern already used in `_postCouncil()` (lines 1353-1357)

2. **`public/js/components/AdvancedConfigTab.js`** (lines 1258-1269)
   - Same fix: add explicit selector update after `await this.loadCouncils()` in `_putCouncil()`
   - Match the pattern from `_postCouncil()` (lines 1290-1293)

## Changes

### VoiceCentricConfigTab.js `_putCouncil` (line ~1337)

After `await this.loadCouncils();`, add:
```javascript
const selector = this.modal.querySelector('#vc-council-selector');
if (selector) {
  selector.value = this.selectedCouncilId;
  selector.classList.remove('new-council-selected');
}
```

### AdvancedConfigTab.js `_putCouncil` (line ~1268)

After `await this.loadCouncils();`, add:
```javascript
const selector = this.modal.querySelector('#council-selector');
if (selector) {
  selector.value = this.selectedCouncilId;
  selector.classList.remove('new-council-selected');
}
```

## Verification

1. Run unit tests: `npm test`
2. Run E2E tests: `npm run test:e2e`
3. Manual verification:
   - Open Analysis Config dialog, configure a council, click "Save As" → council should remain selected
   - Edit the saved council, click "Save" → council should remain selected
   - Verify both VoiceCentricConfigTab (Council tab) and AdvancedConfigTab (Advanced tab)
