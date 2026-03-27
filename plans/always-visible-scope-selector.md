# Always-Visible Scope Selector in Toolbar

## Context

The diff scope selector (branch/staged/unstaged/untracked) is buried inside the gear-icon dropdown. Users don't discover it. The specific pain point: a user with staged files or branch commits alongside unstaged changes never sees scope options because they don't know to click the gear icon. The scope selector should be a visible, always-present toolbar element in local mode.

Additionally, when a refresh results in an empty diff and the scope auto-extends to branch, the user should see the scope selector highlighted to learn about it.

## Approach: New Standalone `ScopeSelector` Component in Toolbar

Extract scope rendering from `DiffOptionsDropdown` into a new `ScopeSelector` component that renders directly in the toolbar. The gear dropdown keeps only whitespace/minimize checkboxes.

## File Changes

### 1. New: `public/js/components/ScopeSelector.js`

Extract and adapt from `DiffOptionsDropdown._renderScopeSelector` (lines 263-382), `_handleStopClick` (384-451), `_updateScopeUI` (459-516), `_setScopeStatus` (453-457).

**Constructor**: `new ScopeSelector(containerEl, { onScopeChange, initialScope, branchAvailable })`

**Public API** (same surface as what DiffOptionsDropdown exposed):
- `scope` getter/setter `{start, end}`
- `branchAvailable` setter (updates disabled state + tooltip on branch stop)
- `clearScopeStatus()`
- `flash()` - new method: adds `scope-selector--flash` CSS class, triggers highlight animation, auto-removes via `animationend`
- `destroy()`

**DOM**: Compact horizontal version of the existing scope track — smaller dots (10px vs 14px), smaller labels (10px font), tighter padding. No "Diff scope" title (toolbar context is sufficient). Status indicator as small text beside the track.

**Disabled branch stop**: `title="No branch changes to review"` tooltip when `branchAvailable === false`. Same visual treatment (opacity 0.5, cursor not-allowed, greyed dot).

**Module export**: `window.ScopeSelector = ScopeSelector` + `module.exports` guard for testing.

### 2. Modify: `public/js/components/DiffOptionsDropdown.js`

Strip all scope code:
- Remove `_renderScopeSelector()`, `_handleStopClick()`, `_updateScopeUI()`, `_setScopeStatus()`
- Remove scope state fields (`_branchAvailable`, `_scopeStart`, `_scopeEnd`, `_scopeStops`, `_scopeTrackEl`, etc.)
- Remove public scope API (`branchAvailable` setter, `scope` getter/setter, `clearScopeStatus()`)
- Remove scope params from constructor (`onScopeChange`, `initialScope`, `branchAvailable`)
- Remove the conditional `_renderScopeSelector` call and divider in `_renderPopover()` (lines 192-201)

Result: ~200 lines (down from 594). Popover = two checkboxes only.

### 3. Modify: `public/local.html`

Add `<div class="toolbar-scope" id="toolbar-scope"></div>` in `.diff-toolbar` between `.toolbar-meta` and `#diff-stats` (after line 406, before line 407).

Add `<script src="/js/components/ScopeSelector.js"></script>` after `DiffOptionsDropdown.js` script tag.

### 4. Modify: `public/css/pr.css`

Add styles:
- `.toolbar-scope` — flex container, `flex-shrink: 0`
- `.toolbar-scope-selector` — compact scope track with background, border, border-radius
- Compact dot and label styles for toolbar context
- `@keyframes scope-highlight-flash` — brief purple glow (box-shadow) that fades over 1.5s, matching the existing `comment-highlight-flash` pattern
- `.scope-selector--flash` class triggers the animation
- Responsive: at `max-width: 768px`, hide scope labels (dots only)

### 5. Modify: `public/js/local.js`

**In `loadLocalReview()` (~line 953-967)**:
- Remove the destroy/recreate of `DiffOptionsDropdown` (pr.js-created instance is already correct without scope)
- Create `ScopeSelector` mounted in `#toolbar-scope`:
  ```js
  if (manager.scopeSelector) manager.scopeSelector.destroy();
  const scopeContainer = document.getElementById('toolbar-scope');
  if (scopeContainer && window.ScopeSelector) {
    manager.scopeSelector = new window.ScopeSelector(scopeContainer, {
      onScopeChange: (start, end) => this._handleScopeChange(start, end),
      initialScope: { start: scopeStart, end: scopeEnd },
      branchAvailable
    });
  }
  ```

**Switch 6 call sites** from `manager.diffOptionsDropdown` to `manager.scopeSelector`:
- `_applyRefreshedDiff` line 815-816: `.branchAvailable`
- `_applyScopeResult` line 1488-1491: `.scope`, `.clearScopeStatus()`
- `_handleScopeChange` error rollback line 1541-1545: `.scope`, `.clearScopeStatus()`
- `showBranchReviewDialog` confirm line 1650-1652: `.branchAvailable`, `.scope`

**Add `flash()` calls**:
1. After `showBranchReviewDialog` confirm completes `_applyScopeResult` (~line 1657): `manager.scopeSelector?.flash()`
2. In empty-diff path before showing branch dialog (~line 1337): `manager.scopeSelector?.flash()`

### 6. Modify: `public/js/pr.js`

- Add `this.scopeSelector = null;` field declaration (after line 138)
- No other changes needed — pr.js already constructs DiffOptionsDropdown without scope params

## Hazards

- `_applyScopeResult` has two callers: `_handleScopeChange` and `showBranchReviewDialog.handleConfirm`. Both update `manager.scopeSelector`. Verify both paths after changes.
- `_applyRefreshedDiff` (line 815) updates branch availability. Must switch to `manager.scopeSelector.branchAvailable` — if missed, branch availability changes after refresh are silently dropped.
- The DiffOptionsDropdown is constructed in both `pr.js` (line 195) and `local.js` (line 960). After stripping scope from the constructor, the pr.js construction is unaffected (never passed scope params). The local.js recreation is removed entirely.
- `_initToolbarHeightTracking` in pr.js uses `ResizeObserver` on `.diff-toolbar` — adding the scope selector element triggers a re-measure. Expected and correct.
- Scope selector only appears in local mode: double-gated by `#toolbar-scope` element only existing in `local.html` AND `ScopeSelector` only instantiated in `local.js`.

## Verification

1. **Unit tests**: Add tests for `ScopeSelector` component — scope getter/setter, branchAvailable setter, flash(), clearScopeStatus(), click handling, disabled branch behavior
2. **Manual test scenarios**:
   - Start local mode with unstaged changes → scope selector visible in toolbar, default scope `unstaged–untracked`
   - Stage some files → staged stop is clickable, extending scope shows staged files in diff
   - Commit to branch → branch stop becomes enabled (if commits ahead of base)
   - Refresh when no uncommitted changes → branch dialog appears, scope selector flashes
   - Confirm branch expansion → scope extends, selector flashes, branch diff shows
   - PR mode → no scope selector in toolbar (only gear dropdown with checkboxes)
3. **E2E tests**: Run existing E2E suite to verify no regressions in local/PR modes
