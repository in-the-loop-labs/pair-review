# Plan: Start AI Review Panel Collapsed for New Reviews

## Context

When opening a new review, the AI Review panel (and Chat panel if previously opened) takes up significant screen real estate while showing zero content — just empty space. This makes the diff view unnecessarily narrow on first load. The panels should start collapsed and expand when they have something to show.

## Changes

### 1. HTML: Start AI panel collapsed

**Files**: `public/pr.html` (line 244), `public/local.html` (line 414)

Add `collapsed` class to `#ai-panel`:
```html
<aside class="ai-panel collapsed" id="ai-panel">
```

The AIPanel constructor already reads this from the DOM (`this.isCollapsed = this.panel?.classList.contains('collapsed')`) and sets `--ai-panel-width: 0px` accordingly. No CSS changes needed — `.ai-panel.collapsed` styles already exist.

### 2. Per-review collapsed state persistence

**File**: `public/js/components/AIPanel.js`

Add three methods following the existing per-review localStorage pattern (`reviewPanelSegment_{prKey}`, `pair-review-show-dismissed_{prKey}`):

- `_getCollapsedStorageKey()` → returns `pair-review-panel-collapsed_{currentPRKey}` or null
- `_saveCollapsedState()` → saves `isCollapsed` to localStorage with per-review key
- `_restoreOrCollapsePanel()` → checks localStorage:
  - Saved `'false'` (user had it expanded) → call `expand()`
  - Saved `'true'` or no saved state (new review) → call `collapse()`

Modify `collapse()` and `expand()` to call `_saveCollapsedState()`.

Modify `setPR()` to call `_restoreOrCollapsePanel()` before restoring segment/filter state.

### 3. Auto-expand on analysis start

**File**: `public/js/components/AIPanel.js`

In `setAnalysisState()`, when state transitions to `'loading'` and panel is collapsed, call `this.expand()`. This covers all analysis entry points since they all funnel through `setAnalysisState('loading')`.

### 4. Fix local mode gap: add `setAnalysisState('loading')` to `checkRunningAnalysis`

**File**: `public/js/local.js` (~line 376)

The local mode `checkRunningAnalysis` override doesn't call `setAnalysisState('loading')` when it detects a running analysis, unlike the PR mode version. Add it so the panel auto-expands for in-progress local analyses.

### 5. Update E2E tests

**File**: `tests/e2e/panel-resize.spec.js`

The `beforeEach` clears `sidebar-width` and `ai-panel-width` from localStorage but doesn't clear the new per-review collapsed key. Since the panel now starts collapsed by default, resize tests that expect to drag the AI panel handle need the panel expanded first. Add per-review collapsed state clearing and/or expand the panel in setup.

**File**: `tests/e2e/panel-group.spec.js`

Same — check if any tests assume the AI panel starts expanded and adjust.

### 6. Unit tests for new behavior

**File**: `tests/unit/ai-panel-collapse.test.js` (new)

- `_restoreOrCollapsePanel()` with no saved state → stays collapsed
- `_restoreOrCollapsePanel()` with saved `'false'` → expands
- `_restoreOrCollapsePanel()` with saved `'true'` → stays collapsed
- `setAnalysisState('loading')` when collapsed → expands
- `setAnalysisState('loading')` when already expanded → no change
- `setAnalysisState('complete')` when collapsed → does NOT expand
- `collapse()` / `expand()` save state to localStorage

## Flow Summary

**New review**: HTML collapsed → `setPR()` → no saved state → stays collapsed → user clicks Analyze → `setAnalysisState('loading')` → auto-expands → state saved as expanded

**Returning visit (was expanded)**: HTML collapsed → `setPR()` → finds `'false'` in localStorage → expands

**Returning visit (was manually collapsed)**: HTML collapsed → `setPR()` → finds `'true'` → stays collapsed

## Verification

1. `npm test` — unit tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: open a new PR review → AI panel should be collapsed, diff gets full width
4. Manual: click Analyze → AI panel should auto-expand with spinner
5. Manual: reload the page → AI panel should restore expanded state
6. Manual: collapse panel, reload → should stay collapsed
7. Manual: open a different (new) PR → should start collapsed again
8. Manual: same flows in local mode
