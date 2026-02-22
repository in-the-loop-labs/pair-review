# Fix: Context file nav shows duplicate entries and doesn't yield to diff files

## Context

`rebuildFileListWithContext()` in `public/js/pr.js:4168-4187` blindly pushes every context file record into the `merged` array. This causes two bugs:

1. **Duplicate nav entries** — If a file has multiple context ranges (multiple hunks), each range produces a separate nav entry for the same file path.
2. **No diff-takes-precedence** — Context files whose path matches an existing diff file appear alongside the diff entry instead of being suppressed.

## Changes

**File:** `public/js/pr.js` — `rebuildFileListWithContext()` (line ~4168)

Replace the current loop that pushes all context files into `merged` with:

1. Build a `Set` of diff file paths from `this.diffFiles`.
2. Deduplicate context files by path — keep only one entry per unique file path (first occurrence wins; the nav entry is just a link, line ranges don't matter for navigation).
3. Skip any context file whose path already exists in the diff file set.

The resulting method (~15 lines) replaces the existing ~20 lines with no API or behavioral changes beyond fixing the two bugs.

## Verification

- Unit tests: add tests for `rebuildFileListWithContext` covering both bugs (duplicate paths, diff-takes-precedence).
- E2E: run existing E2E suite to confirm no regressions.
