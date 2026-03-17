# Branch Review Mode

## Context

When a user opens local mode (`pair-review --local`) on a branch with no uncommitted changes, they currently see an empty "No unstaged changes" message. This is a dead end. Often, they actually want to review the committed changes on their branch before opening a PR. This feature detects that situation and offers to review the branch's commits against its base branch — essentially a local PR preview.

## Scope

A new `local_mode = 'branch'` sub-mode within the existing `review_type = 'local'` system. Reuses 90%+ of local mode infrastructure. The diff source changes from `git diff` (working directory) to `git diff merge-base...HEAD` (committed branch changes).

---

## 1. Base Branch Detection

**New file: `src/git/base-branch.js`**

Single exported function: `detectBaseBranch(repoPath, currentBranch, options)`.

Returns `{ baseBranch, source, prNumber? }` or `null` if no base can be determined.

Priority order:

1. **Graphite** — check `which gt`, then run `gt trunk` and `gt branch parent`. Use parent branch. Timeout 3s. Fail silently.
2. **GitHub PR** — if GitHub token is available, call `octokit.pulls.list({ head: 'owner:branch', state: 'open' })`. If a PR exists, use its `base.ref`. Add `findPRByBranch()` to `src/github/client.js`.
3. **Default branch** — run `git remote show origin`, parse `HEAD branch:` line. Fallback: check if `main` or `master` exists via `git rev-parse --verify`.

Guard rails:
- Return `null` if detached HEAD (`branch === 'HEAD'`)
- Return `null` if current branch IS the base branch (nothing to compare)
- Skip GitHub step gracefully if no token configured

## 2. Branch Diff Generation

**File: `src/local-review.js`** — new function `generateBranchDiff(repoPath, baseBranch, options)`

```
git fetch origin <baseBranch>  (best-effort, fall back to local ref)
git merge-base origin/<baseBranch> HEAD  →  mergeBaseSha
git diff <mergeBaseSha>...HEAD --unified=3 [--w if hideWhitespace]
```

Also: `getBranchCommitCount(repoPath, baseBranch)` → runs `git rev-list --count origin/<baseBranch>..HEAD` for the "N commits ahead" message.

Also: `getFirstCommitSubject(repoPath, baseBranch)` → runs `git log origin/<baseBranch>..HEAD --format=%s --reverse` and takes line 1. Used as default review name.

Staleness for branch mode = HEAD SHA changed (no content-digest needed).

## 3. Data Model Changes

**File: `src/database.js`** — migration v28

Add two columns to `reviews`:
- `local_mode TEXT DEFAULT 'uncommitted'` — `'uncommitted'` or `'branch'`
- `local_base_branch TEXT` — detected base branch name (e.g., `'main'`)

Add one column to `repo_settings`:
- `auto_branch_review INTEGER DEFAULT 0` — `0` = ask, `1` = always, `-1` = never

Update `SCHEMA_SQL.reviews` for fresh installs. Update `ReviewRepository.upsertLocalReview()` and read methods to handle new columns.

Update test schemas: `tests/e2e/global-setup.js`, `tests/integration/routes.test.js`.

## 4. Initialization Flow Change

**File: `src/local-review.js`** — modify `handleLocalReview()`

After generating uncommitted diff, if diff is empty:
1. Call `detectBaseBranch()` to find base branch and `getBranchCommitCount()` for commit count
2. If no base found or no commits ahead → proceed with empty diff as today
3. Store the detection results (baseBranch, commitCount, source) in the review metadata so the frontend can display the prompt
4. The review is created with `local_mode = 'uncommitted'` initially — the frontend prompt triggers the switch to branch mode

**The prompt-first flow**: The user always sees the prompt before branch review activates. The empty diff area shows: "No uncommitted changes. This branch has N commits ahead of `main`. [Review Branch Changes] [Don't ask again]". Clicking "Review Branch Changes" calls the backend to switch to branch mode, regenerate the diff, and reload.

**"Don't ask again" preference**: Stored per-repo in `repo_settings.auto_branch_review`. When set to `-1` (never), the prompt is suppressed and empty diff shows as today. No auto-switch option — always prompt-first (can add later).

## 5. Backend Route Changes

**File: `src/routes/local.js`**

### `GET /api/local/:reviewId` (metadata)
Add `localMode`, `baseBranch`, and `branchInfo` to response. `branchInfo` is populated when `localMode === 'uncommitted'` and branch detection found a viable base: `{ baseBranch, commitCount, source }`. This powers the frontend prompt without an extra round-trip.

### `GET /api/local/:reviewId/diff`
When `local_mode === 'branch'`: call `generateBranchDiff()` instead of `generateLocalDiff()`.

### `GET /api/local/:reviewId/check-stale`
When `local_mode === 'branch'`: compare stored `local_head_sha` against current HEAD SHA (simpler than content-digest).

### `POST /api/local/:reviewId/refresh`
When `local_mode === 'branch'`: re-run `generateBranchDiff()` with stored `local_base_branch`. HEAD-change detection and session-switch flow stays the same.

### `POST /api/local/:reviewId/analyses`
When `local_mode === 'branch'`: set `localMetadata.base_sha` to the merge-base SHA (not HEAD). This gives the analyzer proper diff context.

### `POST /api/local/start` (web UI start)
Add branch detection when the started review has an empty uncommitted diff. Return `localMode`, `baseBranch`, `commitCount` so the frontend can prompt.

### New: `POST /api/local/:reviewId/switch-to-branch`
Called when user accepts the branch review prompt from the web UI. Re-generates diff in branch mode, updates the review record.

## 6. Frontend Changes

**File: `public/js/local.js`**

### `loadLocalReview()`
Set `currentPR.base_branch` to `reviewData.baseBranch` when in branch mode (currently both base/head are set to the same branch).

### `updateLocalHeader()`
When `localMode === 'branch'`:
- Show base branch badge next to the head branch badge with a "vs" separator
- Example: `feature-x` vs `main`

### `loadLocalDiff()` — empty diff prompt (core UX)
When diff is empty AND `localMode === 'uncommitted'`, replace the current dead-end "No unstaged changes" message. Check `reviewData.branchInfo` (populated by the metadata endpoint when branch detection found results). If available, render:

```
┌─────────────────────────────────────────────────────┐
│  No uncommitted changes to review.                  │
│                                                     │
│  This branch has 5 commits ahead of `main`.         │
│                                                     │
│  [Review Branch Changes]                            │
│                                                     │
│  [ ] Don't ask again for this repository            │
└─────────────────────────────────────────────────────┘
```

- "Review Branch Changes" calls `POST /api/local/:reviewId/switch-to-branch`, then reloads the page
- "Don't ask again" checkbox saves `auto_branch_review = -1` to repo settings (future opens show the plain empty message)
- If `branchInfo` is null (no base detected, or on default branch), show the existing empty message as today

### Refresh button
Tooltip changes to "Refresh diff from branch" in branch mode.

## 7. Key Files

| File | Changes |
|------|---------|
| `src/git/base-branch.js` | **New** — `detectBaseBranch()` |
| `src/github/client.js` | Add `findPRByBranch()` |
| `src/local-review.js` | Add `generateBranchDiff()`, modify `handleLocalReview()` |
| `src/database.js` | Migration v28, update ReviewRepository |
| `src/routes/local.js` | Branch-aware diff/stale/refresh/analysis, new switch endpoint |
| `public/js/local.js` | Header, empty-diff prompt, currentPR.base_branch |
| `public/local.html` | Base branch badge element in header |

## 8. Edge Cases

- **Detached HEAD**: skip branch detection, show empty diff
- **On default branch**: no base to compare, show empty diff
- **No remote**: fall back to checking local `main`/`master` refs
- **No GitHub token**: skip PR lookup, Graphite + default branch still work
- **Graphite not installed**: `which gt` fails silently, next strategy
- **Zero commits ahead**: show empty diff (branch is at same point as base)
- **Both uncommitted + branch changes**: always show uncommitted (current behavior). Branch mode only when uncommitted diff is empty.
- **Fetch fails** (offline): use stale local `origin/<base>` ref, log warning

## 9. Verification

1. **Unit tests**: `detectBaseBranch()` with mocked git/gt/GitHub responses (use `_deps` pattern)
2. **Unit tests**: `generateBranchDiff()` output parsing
3. **Integration tests**: route changes for branch mode metadata, diff, stale, refresh
4. **Manual test**: run `pair-review --local` on a branch with commits ahead, verify prompt appears
5. **Manual test**: verify base branch detection with Graphite, GitHub PR, and default branch fallback
6. **E2E test**: branch review flow end-to-end
