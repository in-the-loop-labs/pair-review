# Constrain Diff Scope to Always Include Unstaged

## Context

When AI models analyze local changes, they read files from the working tree. If a user selects a scope that excludes unstaged changes (e.g., "staged only"), the diff and the files the model reads diverge — the diff says one thing, the working tree says another. Since pair-review must not modify local git state (no stash/checkout) and `git show` is too unreliable across diverse AI agents, the fix is to enforce `unstaged` as the minimum right boundary of every valid scope.

**Valid scopes after this change:**

| Scope | Git command |
|---|---|
| `unstaged` | `git diff` |
| `unstaged..untracked` | `git diff` + untracked listing |
| `staged..unstaged` | `git diff HEAD` |
| `staged..untracked` | `git diff HEAD` + untracked |
| `branch..unstaged` | `git diff <merge-base>` |
| `branch..untracked` | `git diff <merge-base>` + untracked |

**Removed:** `branch..branch`, `branch..staged`, `staged..staged`, `untracked..untracked`

---

## Implementation

### 1. `src/local-scope.js` — Core validation

**Tighten `isValidScope`** — add `si <= 2 && ei >= 2` (index of `unstaged` is 2):

```js
return si !== -1 && ei !== -1 && si <= ei && si <= 2 && ei >= 2;
```

This is the keystone change. Every caller of `isValidScope` automatically rejects the 4 removed scopes.

**Add `normalizeScope(start, end)`** — clamps invalid scopes to the nearest valid one. Used by the metadata endpoint and DB migration fallback:
- Clamps `end` up to at least `unstaged` (index 2)
- Clamps `start` down to at most `unstaged` (index 2) if start > end after clamping
- Falls back to `DEFAULT_SCOPE` for unknown stops

Migration mapping: `branch..branch` → `branch..unstaged`, `staged..staged` → `staged..unstaged`, `untracked..untracked` → `unstaged..untracked`.

**Update `fromLegacyMode`** — change `'branch'` mapping from `branch..branch` to `branch..unstaged`.

**Remove dead hint entries from `scopeGitHints`** — delete keys `branch-branch`, `branch-staged`, `staged-staged`, `untracked-untracked`. Also remove the `includesUntracked` special case for `untracked-untracked` since that key no longer exists.

Export `normalizeScope` from the `LocalScope` object.

### 2. `src/database.js` — Migration (version 36)

Bump `CURRENT_SCHEMA_VERSION` to 36. Migration SQL:

```sql
-- Expand scopes where end < unstaged
UPDATE reviews SET local_scope_end = 'unstaged'
  WHERE local_scope_end IN ('branch', 'staged') AND review_type = 'local';

-- Fix untracked-only → unstaged..untracked
UPDATE reviews SET local_scope_start = 'unstaged'
  WHERE local_scope_start = 'untracked' AND local_scope_end = 'untracked'
  AND review_type = 'local';
```

`analysis_runs` scope columns are historical records — leave them as-is.

### 3. `src/routes/local.js` — Metadata normalization

In `GET /api/local/:reviewId/metadata`, apply `normalizeScope` when reading scope from DB (belt-and-suspenders for un-migrated rows):

```js
const { start: scopeStart, end: scopeEnd } = normalizeScope(
  review.local_scope_start || DEFAULT_SCOPE.start,
  review.local_scope_end || DEFAULT_SCOPE.end
);
```

Import `normalizeScope` from `local-scope.js` (already imports other functions from this module).

The `POST set-scope` endpoint already validates via `isValidScope` and returns 400 — no changes needed.

### 4. `src/local-review.js` — Remove dead branches in `generateScopedDiff`

Remove three unreachable branches (lines 488-511):
- `hasBranch && !hasStaged && !hasUnstaged` (branch-only)
- `hasBranch && hasStaged && !hasUnstaged` (branch-staged)
- `hasStaged && !hasUnstaged` (staged-only)

Remove the `// hasUntracked-only` comment at line 525 (also dead).

Add a comment explaining `hasUnstaged` is always true by invariant.

The remaining branches are exhaustive for all valid scopes:
1. `hasBranch && hasUnstaged` → `git diff <merge-base>`
2. `hasStaged && hasUnstaged` → `git diff HEAD`
3. `hasUnstaged` → `git diff`

### 5. `public/js/components/DiffOptionsDropdown.js` — UI constraints

**`_handleStopClick`:**

- **Alt-click:** Replace solo-select with minimum-unstaged enforcement:
  ```js
  const ui = stops.indexOf('unstaged');
  newStart = stops[Math.min(ci, ui)];
  newEnd = stops[Math.max(ci, ui)];
  ```
  Result: alt+branch → `branch..unstaged`, alt+staged → `staged..unstaged`, alt+unstaged → `unstaged..unstaged`, alt+untracked → `unstaged..untracked`.

- **Regular click on `unstaged` when it's a boundary:** Add early return to prevent toggling it off:
  ```js
  if (clickedStop === 'unstaged') return; // unstaged is mandatory
  ```
  Place this inside the "Toggling OFF" block, before the `ci === si` / `ci === ei` checks.

- The existing `isValidScope` guard at line 434 is the final safety net — any scope that somehow slips through will be rejected there.

**`_updateScopeUI`:**

- Update `isBoundary` calculation to exclude `unstaged` from clickable boundaries:
  ```js
  const isMandatory = stop === 'unstaged';
  const isBoundary = included && (i === si || i === ei) && si !== ei && !isMandatory;
  ```
  This ensures the cursor shows `default` (not `pointer`) on `unstaged` when clicking would be a no-op.

### 6. Tests

**`tests/unit/local-scope.test.js`:**
- `isValidScope`: Move 4 removed scopes to a new "rejects scope that excludes unstaged" test block
- `scopeLabel`: Update — `scopeLabel('branch','branch')` etc. now return `''`
- `scopeGitHints`: Reduce valid combo list from 10 to 6, remove tests referencing dead keys
- `scopeIncludes`: `scopeIncludes('staged','staged','staged')` now returns `false` (invalid scope)
- `fromLegacyMode`: Update `'branch'` expectation to `{ start: 'branch', end: 'unstaged' }`
- Add `normalizeScope` test group covering all 4 invalid→valid mappings plus pass-through for valid scopes and unknown stops

**`tests/unit/local-review.test.js`:**
- Update tests using `staged..staged`, `branch..branch`, `untracked..untracked`, `branch..staged` to use valid scopes instead

**`tests/unit/chat/prompt-builder.test.js`:**
- Update `local_scope_start: 'staged', local_scope_end: 'staged'` to `staged..unstaged`

**`tests/integration/local-sessions.test.js`:**
- Update `scopeEnd: 'branch'` to `scopeEnd: 'unstaged'` in set-scope tests
- Update `updateLocalScope(id, 'branch', 'branch', ...)` calls to use valid scopes

### 7. Changeset

Create `.changeset/<name>.md` — `patch` for `@in-the-loop-labs/pair-review`:
> Constrain local review diff scope to always include unstaged changes, ensuring the diff matches the working tree files AI reviewers read.

---

## Hazards

- **`isValidScope` has wide call surface**: Called by `scopeIncludes` (→ `generateScopedDiff`, `computeScopedDigest`, `getChangedFiles`, `_updateScopeUI`), `scopeGitHints`, `scopeLabel`, `DiffOptionsDropdown` setter, `POST set-scope`. Tightening it affects all these paths. The `normalizeScope` addition at the metadata endpoint prevents stale DB rows from causing failures.
- **`_applyScopeResult` has two callers**: `_handleScopeChange` and `showBranchReviewDialog`. Both send scope to the backend first, which validates. After migration, `showBranchReviewDialog` always sends `scopeStart: 'branch'` with `scopeEnd >= 'unstaged'` (valid).
- **`scopeIncludes` returns `false` for invalid scopes**: So `generateScopedDiff` produces an empty diff if called with a now-invalid scope. The migration + normalization prevents this, but it's a safe failure mode (empty diff > wrong diff).
- **`updateLocalScope` in DB layer does NOT validate**: It writes whatever is passed. Tests that call it directly with invalid scopes will succeed at DB level but create invalid state. Update tests to use valid scopes.
- **Integration tests hard-code scope values**: Multiple tests in `local-sessions.test.js` use `branch..branch`. All must be updated.

## Verification

1. `npm test -- tests/unit/local-scope.test.js` — scope validation, normalization, hints
2. `npm test -- tests/unit/local-review.test.js` — diff generation with valid scopes only
3. `npm test -- tests/unit/chat/prompt-builder.test.js` — chat hints
4. `npm test -- tests/integration/local-sessions.test.js` — set-scope endpoint
5. `npm test` — full suite
6. `npm run test:e2e` — scope selector in browser
7. Manual: open local review, verify unstaged dot always filled, alt-click behavior correct
