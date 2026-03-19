# Diff Scope Range Selector

## Context

Local mode currently has two rigid modes: `uncommitted` (unstaged + untracked) and `branch` (committed changes vs base). The user switches between them via a dialog prompt. This is limiting — users may want to review staged changes, branch + WIP edits, or just untracked files.

Replace the binary mode with a **range selector** over four ordered stops: **Branch, Staged, Unstaged, Untracked**. The user selects any contiguous sub-range. This gives 10 valid states, all with clear git semantics.

The range selector lives inside the existing **Diff Options** popover (gear icon), not directly on the toolbar — keeps the main UI clean.

---

## 1. Scope Model

Four stops, ordered left to right:

| # | Stop | What it adds |
|---|------|-------------|
| 1 | Branch | Committed changes vs merge-base |
| 2 | Staged | `git add`'d changes |
| 3 | Unstaged | Edits to tracked files not yet staged |
| 4 | Untracked | New files not tracked by git |

A scope is a contiguous range `[start, end]`. Both handles can sit on the same stop. 10 valid combinations.

### Git commands per range

Verified against a real repo with all four layers present:

| Range | Git command(s) |
|-------|---------------|
| Branch | `git diff <mergebase>..HEAD` |
| Branch–Staged | `git diff --cached <mergebase>` |
| Branch–Unstaged | `git diff <mergebase>` |
| Branch–Untracked | `git diff <mergebase>` + untracked diffs |
| Staged | `git diff --cached` |
| Staged–Unstaged | `git diff HEAD` |
| Staged–Untracked | `git diff HEAD` + untracked diffs |
| Unstaged | `git diff` |
| Unstaged–Untracked | `git diff` + untracked diffs **(today's default)** |
| Untracked | untracked diffs only |

Key insight: when Branch is in scope, all diffs anchor against the merge-base (not HEAD). Otherwise, diffs anchor against HEAD (staged) or INDEX (unstaged).

---

## 2. Data Model (Migration v29)

**File: `src/database.js`**

Replace `local_mode TEXT` with two columns on `reviews`:

```sql
local_scope_start TEXT DEFAULT 'unstaged'
local_scope_end TEXT DEFAULT 'untracked'
```

Keep `local_base_branch TEXT` — needed when branch is in scope.

Migration maps existing data:
- `local_mode = 'uncommitted'` → `start='unstaged', end='untracked'`
- `local_mode = 'branch'` → `start='branch', end='branch'`

Update `SCHEMA_SQL.reviews` for fresh installs. Update test schema in `tests/utils/schema.js`.

---

## 3. Scope Constants Module

**New file: `src/local-scope.js`**

Pure utility — shared by backend and frontend (via `if (typeof module !== 'undefined')` pattern).

Exports:
- `STOPS = ['branch', 'staged', 'unstaged', 'untracked']`
- `isValidScope(start, end)` — checks contiguity
- `scopeIncludes(start, end, stop)` — range membership test
- `includesBranch(start)` — shorthand for `start === 'branch'`
- `fromLegacyMode(localMode)` — backward compat
- `scopeLabel(start, end)` — human-readable label
- `DEFAULT_SCOPE = { start: 'unstaged', end: 'untracked' }`

---

## 4. Unified Diff Generation

**File: `src/local-review.js`**

New function: `generateScopedDiff(repoPath, scopeStart, scopeEnd, baseBranch, options)`

Dispatches to the correct git command based on scope range. Returns `{ diff, stats, mergeBaseSha }`.

Keep `generateLocalDiff` and `generateBranchDiff` as thin wrappers calling `generateScopedDiff` to avoid breaking existing callers during transition.

New function: `computeScopedDigest(repoPath, scopeStart, scopeEnd)` — replaces `computeLocalDiffDigest`. Hashes exactly what the current scope shows:
- Branch in scope → include HEAD SHA in hash input
- Staged in scope → include `git diff --cached` output
- Unstaged in scope → include `git diff` output
- Untracked in scope → include untracked file list with sizes/mtimes

---

## 5. ReviewRepository Updates

**File: `src/database.js`**

- `upsertLocalReview`: Accept `scopeStart`, `scopeEnd` instead of `localMode`
- `getLocalReview`, `getLocalReviewById`: Include new columns in SELECT
- Rename `getLocalBranchReview` → `getLocalBranchScopeReview`: Query `WHERE local_scope_start = 'branch'`
- Add `updateLocalScope(id, scopeStart, scopeEnd, baseBranch)` for the set-scope endpoint

---

## 6. Route Changes

**File: `src/routes/local.js`**

Replace all `isBranchMode` conditionals with scope-aware checks using `scopeIncludes`.

### Endpoint changes:

| Endpoint | Change |
|----------|--------|
| `GET /:reviewId` | Return `scopeStart`, `scopeEnd` instead of `localMode` |
| `GET /:reviewId/diff` | Use `generateScopedDiff` |
| `GET /:reviewId/check-stale` | Use `computeScopedDigest`. Branch-in-scope → also compare HEAD SHA |
| `POST /:reviewId/refresh` | Use `generateScopedDiff`. Branch-in-scope → update HEAD SHA, no new session |
| `POST /:reviewId/analyses` | Compute `base_sha` based on scope. Scope-aware `changedFiles` |
| `POST /:reviewId/analyses/council` | Same scope-aware logic |
| `POST /:reviewId/switch-to-branch` | **Replace** with `POST /:reviewId/set-scope` |

### New endpoint: `POST /:reviewId/set-scope`

```
Body: { scopeStart, scopeEnd, baseBranch? }
```

- Validates scope with `isValidScope`
- Validates branch name if branch in scope
- Detects baseBranch if not provided and branch is in scope
- Updates DB columns
- Regenerates diff via `generateScopedDiff`
- Auto-names review from first commit subject if branch newly included
- Returns new diff stats + scope info

### branchInfo prompt

The branchInfo detection in GET metadata still fires when scope does NOT include branch and branch has commits ahead. The frontend uses this to suggest expanding scope.

---

## 7. Session Persistence

Logic stays the same, just generalized:
- Scope includes branch → session persists across HEAD changes (lookup by path + `local_scope_start = 'branch'`)
- Scope excludes branch → new session per HEAD SHA

---

## 8. Invalidation on Scope Change

When the user changes scope via `set-scope`:

### Diff
- Completely regenerated. In-memory cache cleared, new diff stored in DB.
- Frontend reloads diff after scope change completes.

### AI Suggestions
- Previous analysis ran against different diff content. Line numbers may not match.
- **Don't delete old analysis runs.** They stay in analysis history.
- Record `scope_start` and `scope_end` on each `analysis_runs` row (new columns) so the UI can show context.
- When the active analysis run's scope differs from the current review scope, show a notice: "This analysis was run on a different scope (Branch only). Re-analyze to match current scope."
- The "Analyze" button works normally — it always analyzes the current diff regardless of scope history.

### User Comments
- User comments are anchored to file + line number. After scope change, some files/lines may not exist in the new diff.
- **Don't delete comments.** Keep them in DB.
- Comments whose file exists in the new diff: render normally (line anchoring may shift but the file-level context survives).
- Comments whose file does NOT exist in the new diff: show in the AI panel list but not inline (same behavior as when a file is removed from a PR).

### Staleness Baseline
- Scope change resets the staleness digest. The new diff becomes the baseline.

---

## 9. Frontend: Range Selector in DiffOptionsDropdown

**File: `public/js/components/DiffOptionsDropdown.js`**

The range selector is added inside the existing popover, below the "Hide whitespace changes" checkbox. Separated by a subtle divider.

### Popover layout after change:

```
┌──────────────────────────────────┐
│ ☑ Hide whitespace changes        │
│ ─────────────────────────────── │
│ Diff scope                       │
│                                  │
│  ●━━━━━●━━━━━○━━━━━○             │
│  Branch Staged Unstaged Untracked│
│  ◄─── included ───►             │
└──────────────────────────────────┘
```

- Four stops on a horizontal track
- Filled circles (●) = included in range
- Empty circles (○) = excluded
- Highlighted bar between the start and end handles
- Click a stop to move the nearest handle to it
- Branch stop is disabled/grayed when on default branch or detached HEAD

### Constructor changes:

`DiffOptionsDropdown` gains a new callback:
```js
constructor(buttonElement, {
  onToggleWhitespace,
  onScopeChange,       // (scopeStart, scopeEnd) => void
  initialScope,        // { start, end }
  branchAvailable      // boolean — can the Branch stop be selected?
})
```

### Persistence:

Scope is stored per-review in localStorage: `pair-review-scope:local-{reviewId}` → `{ start, end }`.

On scope change:
1. Update localStorage
2. Fire `onScopeChange(start, end)` callback
3. LocalManager calls `POST /api/local/:reviewId/set-scope`
4. On success, reload diff

---

## 10. Frontend: LocalManager Updates

**File: `public/js/local.js`**

- `loadLocalReview()`: Read `scopeStart`/`scopeEnd` from metadata. Pass to DiffOptionsDropdown as `initialScope` + `branchAvailable`.
- `updateLocalHeader()`: Show scope-aware label + base branch when relevant. Replace "branch vs base" badge logic.
- `showBranchReviewDialog()`: Change to "Expand scope to include branch changes". Call `set-scope` instead of `switch-to-branch`.
- `currentPR` construction: Set `base_branch` when branch is in scope.
- New `onScopeChange` handler: POST to set-scope, reload diff on success.
- Refresh button tooltip: scope-aware ("Refresh diff" is fine for all scopes).

---

## 11. Frontend: local.html

- Add `<script src="/js/local-scope.js"></script>` before DiffOptionsDropdown script (shared constants)
- No new container div needed — range selector is inside the existing popover

---

## 12. Analysis Runs: Scope Tracking

**File: `src/database.js`**

Add to `analysis_runs` table (migration v29):
```sql
scope_start TEXT
scope_end TEXT
```

When creating an analysis run, record the current scope. The frontend can compare `run.scope_start/end` against the review's current scope to show the mismatch notice.

---

## 13. Key Files

| File | Changes |
|------|---------|
| `src/local-scope.js` | **New** — scope constants and utilities |
| `src/local-review.js` | `generateScopedDiff`, `computeScopedDigest`, wrapper functions |
| `src/database.js` | Migration v29, ReviewRepository scope methods, analysis_runs scope columns |
| `src/routes/local.js` | All endpoints scope-aware, new `set-scope` endpoint |
| `public/js/components/DiffOptionsDropdown.js` | Range selector inside popover |
| `public/js/local.js` | LocalManager scope integration |
| `public/local.html` | Script tag for local-scope.js |
| `tests/utils/schema.js` | New columns in test schema |

---

## 14. Implementation Order

1. `src/local-scope.js` + unit tests (pure functions, no deps)
2. Database migration v29 + test schema updates
3. `generateScopedDiff` + `computeScopedDigest` + unit tests
4. ReviewRepository method updates
5. Route changes (replace isBranchMode, add set-scope, remove switch-to-branch)
6. Range selector inside DiffOptionsDropdown + CSS
7. LocalManager updates + local.html script tag
8. Analysis runs scope tracking
9. Integration tests
10. Cleanup: remove `local_mode` references, old wrappers

---

## 15. Verification

1. **Unit tests**: All 10 scope ranges produce correct git output
2. **Unit tests**: Scope constants (isValidScope, scopeIncludes, fromLegacyMode)
3. **Unit tests**: Staleness detection per scope type
4. **Integration tests**: set-scope endpoint, metadata, diff, refresh
5. **Manual test**: Open Diff Options popover, change scope via range selector, verify diff updates
6. **Manual test**: Branch stop disabled on default branch
7. **Manual test**: Session persists across commits when branch in scope
8. **Manual test**: Dialog suggests expanding scope when branch has commits
9. **Manual test**: Change scope, verify old AI suggestions show "different scope" notice
10. **Manual test**: User comments survive scope change
11. **E2E test**: Full scope change flow
