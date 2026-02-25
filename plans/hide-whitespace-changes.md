# Plan: Hide Whitespace Changes Option

## Context

Users reviewing diffs with whitespace-only changes (indentation reformats, trailing whitespace cleanups) see visual noise that obscures meaningful code changes. Adding a "Hide whitespace changes" toggle — behind a diff options dropdown like GitHub's — lets reviewers focus on substantive changes. The dropdown structure also provides a natural extension point for future diff display options.

## Approach: Backend Regeneration with `git diff -w`

When the toggle is active, the frontend re-fetches the diff with `?w=1` and the backend regenerates it using `git diff -w`. This leverages git's well-tested whitespace handling rather than attempting client-side filtering.

## Implementation

### 1. Backend: PR diff endpoint (`src/routes/pr.js:620-692`)

Add `?w=1` query parameter support. When present, regenerate the diff from the worktree instead of using cached `pr_data`:

- Read `req.query.w === '1'`
- If true and worktree exists on disk, use `simpleGit(worktreeRecord.path)` (already imported, line 30) to run:
  - `git.diff([base_sha...head_sha, '--unified=3', '-w'])` for the diff
  - `git.diffSummary([base_sha...head_sha, '-w'])` for changed_files stats
- Parse `prData` for `base_sha`/`head_sha` (already done at line 648)
- Wrap in try/catch; fall back to cached diff on failure
- Files that differ only in whitespace will naturally disappear from the diff

### 2. Backend: Local diff endpoint (`src/routes/local.js:447-524`)

Add `?w=1` query parameter support. When present, regenerate the diff instead of using cached data:

- Read `req.query.w === '1'`
- If true, call `generateLocalDiff(review.local_path, { hideWhitespace: true })` (already exported from `src/local-review.js`)
- Do NOT cache the whitespace-filtered version (it's a transient view)

### 3. Backend: `generateLocalDiff` (`src/local-review.js:369-474`)

Add `options` parameter with `hideWhitespace` support:

- Change signature: `async function generateLocalDiff(repoPath, options = {})`
- When `options.hideWhitespace`, append `-w` to the `git diff` commands (lines 381, 393)
- Also append `-w` to the `git diff --no-index` command for untracked files (line 430)

### 4. Frontend: New `DiffOptionsDropdown` component (`public/js/components/DiffOptionsDropdown.js`)

New file. Small dropdown popover anchored to a gear icon button, following the `PanelGroup._showPopover()` / `_hidePopover()` pattern (`public/js/components/PanelGroup.js:237-283`):

- Gear icon button (`.btn.btn-sm.btn-icon`, id `diff-options-btn`)
- Popover div positioned below button via `getBoundingClientRect()`
- Single checkbox: "Hide whitespace changes"
- Click-outside-to-close + Escape key dismiss
- Reads/writes `localStorage` key `pair-review-hide-whitespace`
- Fires callback `onToggleWhitespace(boolean)` when toggled
- Adds `.active` class to gear button when any option is active (visual cue that diff is filtered)
- Constructor accepts the button element (already in HTML) rather than creating it

### 5. Frontend: HTML changes

**`public/pr.html`** (line ~193, before `#analyze-btn`): Add gear icon button markup and script tag for `DiffOptionsDropdown.js`

**`public/local.html`** (line ~370, same position): Same button markup and script tag

### 6. Frontend: PR mode integration (`public/js/pr.js`)

- Add `this.hideWhitespace` property, initialized from localStorage in constructor
- Modify `loadAndDisplayFiles` (line 579): append `?w=1` to fetch URL when `this.hideWhitespace` is true
- Add `handleWhitespaceToggle(hide)` method:
  1. Set `this.hideWhitespace = hide`
  2. Save scroll position (`window.scrollY`)
  3. Re-call `loadAndDisplayFiles()` (this clears and re-renders the diff)
  4. Re-anchor comments via `loadUserComments()` and suggestions via `loadAISuggestions()`
  5. Restore scroll position after render
- Initialize `DiffOptionsDropdown` during setup, passing the callback

### 7. Frontend: Local mode integration (`public/js/local.js`)

- In `patchPRManager()`, override `handleWhitespaceToggle` to call `loadLocalDiff()` instead of `loadAndDisplayFiles()`
- In `loadLocalDiff()` (line ~1053): append `?w=1` to fetch URL when `window.prManager.hideWhitespace` is true

### 8. CSS styles (`public/css/pr.css`)

Add styles for `.diff-options-popover` following existing popover patterns:
- `position: fixed`, `z-index: 1100`
- Opacity/transform transition for show/hide animation
- Checkbox label styling
- `.active` state for gear button (accent color)
- Dark theme support via `[data-theme="dark"]` selector and CSS variables

### 9. Changeset (`.changeset/hide-whitespace-changes.md`)

```
---
"@in-the-loop-labs/pair-review": minor
---
Add "Hide whitespace changes" option to diff toolbar
```

## Edge Cases

- **Worktree cleaned up (PR mode)**: If worktree path doesn't exist on disk, fall back to cached diff silently. The toggle will have no visible effect.
- **Files vanishing entirely**: Files with only whitespace changes disappear from the diff. This is correct behavior and matches GitHub.
- **Comment anchoring**: Comments on whitespace-only lines won't find their anchor row when hidden. They remain in the DB and panel — just not inline. This matches GitHub's behavior.
- **Scroll position**: Save `window.scrollY` before re-fetch, restore after render with a short delay.

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `src/routes/pr.js` | Modify | `?w=1` support on diff endpoint |
| `src/routes/local.js` | Modify | `?w=1` support on local diff endpoint |
| `src/local-review.js` | Modify | Add `options.hideWhitespace` to `generateLocalDiff()` |
| `public/js/components/DiffOptionsDropdown.js` | **New** | Dropdown component |
| `public/js/pr.js` | Modify | `hideWhitespace` state, toggle handler, `?w=1` in fetch |
| `public/js/local.js` | Modify | Override toggle handler, `?w=1` in fetch |
| `public/pr.html` | Modify | Gear button in toolbar, script tag |
| `public/local.html` | Modify | Gear button in toolbar, script tag |
| `public/css/pr.css` | Modify | Popover styles |
| `.changeset/hide-whitespace-changes.md` | **New** | Changeset |

## Verification

1. **Unit tests**: Test `generateLocalDiff` with `{ hideWhitespace: true }` produces correct git flags
2. **Integration tests**: Test both diff endpoints respond correctly with/without `?w=1`
3. **E2E tests**: Toggle checkbox, verify diff re-renders, verify localStorage persistence across reload, verify both PR and local modes
4. **Manual**: Create a PR/local review with whitespace-only changes, toggle the option, confirm those changes disappear
