# Always-Visible Diff Scope in Diff Options Dropdown

## Context

The diff scope selector (branch/staged/unstaged/untracked) inside the gear-icon dropdown (`DiffOptionsDropdown`) sometimes fails to render in local mode. When a local checkout has only staged changes, the default scope (unstaged–untracked) shows nothing — and the user cannot change the scope because the scope control is missing from the dropdown. The scope selector must always render inside the diff options dropdown in local mode, and the branch stop should show a tooltip explaining why it's disabled when unavailable.

## Approach

Harden the scope selector rendering in `DiffOptionsDropdown` so it always appears in local mode. Add a tooltip to the disabled branch stop. The scope selector stays inside the gear dropdown (not extracted to the toolbar).

## File Changes

### 1. Modify: `public/js/components/DiffOptionsDropdown.js`

**Rendering guard (L192)**: Currently checks `window.PAIR_REVIEW_LOCAL_MODE && window.LocalScope`. Change to also render when scope params are explicitly provided (i.e., `onScopeChange` was passed), as a belt-and-suspenders approach:
```js
const isLocalScope = (window.PAIR_REVIEW_LOCAL_MODE && window.LocalScope) || this._onScopeChange;
if (isLocalScope) {
  this._renderScopeSelector(popover);
  // divider...
}
```

**Disabled branch tooltip (in `_updateScopeUI`, L477-484)**: Add `title` attribute to the branch stop container when disabled:
```js
containerEl.title = disabled ? 'No branch commits ahead of base — nothing to review' : '';
```

### 2. Tests

- Add unit tests for `DiffOptionsDropdown` covering:
  - Scope selector renders when `onScopeChange` is provided even if `window.LocalScope` is not set
  - Scope selector renders when both globals are set (existing behavior)
  - Disabled branch stop has a tooltip explaining why
  - Branch stop click is ignored when disabled

## Hazards

- `_renderScopeSelector` references `window.LocalScope` internally (e.g., `LS.STOPS`, `LS.DEFAULT_SCOPE`). If `window.LocalScope` is truly undefined but `onScopeChange` was passed, this would crash. Need a fallback: use a minimal inline `STOPS` constant if `window.LocalScope` is unavailable.
- The pr.js construction (L195) does NOT pass `onScopeChange`, so the guard change won't cause the scope selector to appear in PR mode.

## Verification

1. Unit tests for the rendering guard and tooltip
2. Manual: open local mode with staged-only changes → open gear dropdown → scope selector is present, can expand to staged
3. Manual: PR mode → gear dropdown has no scope selector
4. E2E test suite passes
