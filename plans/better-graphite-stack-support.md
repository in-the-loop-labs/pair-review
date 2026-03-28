# Plan: Better Graphite Stack Support

## Context

Users reviewing stacked PRs (via Graphite) can't change the diff base to see cumulative changes. If you're reviewing `feat-b` which is stacked on `feat-a`, the diff only shows changes against `feat-a` — there's no way to see the cumulative diff against `main`. This plan adds a base branch selector populated from the Graphite stack topology, plus replaces the current `tryGraphite()` with a more efficient implementation.

**Scope**: Backend foundation (replace `tryGraphite`, return stack data) + base branch selector in the toolbar. No breadcrumb, no stack indicator, no stack navigation — those are deferred to a future design pass that addresses full-stack review workflow and monorepo worktree latency.

---

## Data Sources (no GitHub API calls, no DB storage)

| Source | Data | Access |
|--------|------|--------|
| `gt state` (execSync, ~100ms) | Branch topology: `{ [branch]: { trunk, parents: [{ref, sha}] } }` | Run in worktree/repo path |
| `.graphite_pr_info` (file read) | PR numbers, state, URLs per branch via `headRefName` | `$(git rev-parse --git-common-dir)/.graphite_pr_info` |

- **No `--json` flag on `gt state`** — the command outputs JSON natively (verified on gt v1.8.2)
- **No DB column needed** — stack data is computed on-the-fly from the worktree on each request
- Join the two sources by matching branch name in `gt state` to `headRefName` in `.graphite_pr_info`

---

## Phase 1: Backend — Stack Detection

### 1.1 Replace `tryGraphite()` in `src/git/base-branch.js`

Replace `tryGraphite()` (lines 61–99) with `tryGraphiteState()`:

- Single `execSync('gt state', { cwd: repoPath, encoding: 'utf8', timeout: 5000 })`
- Parse JSON output
- Find trunk: entry where `trunk === true`
- Find parent: `state[currentBranch].parents[0].ref`
- Call `buildStack()` to walk parent chain from currentBranch up to trunk
- Return `{ baseBranch: parent, source: 'graphite', stack }` or `null` on failure

Add `buildStack(state, currentBranch, trunk)`:
- Walk from `currentBranch` up via `parents[0].ref` with cycle protection (`Set`)
- Return array ordered trunk-first: `[{branch:'main', isTrunk:true, parentBranch:null}, ..., {branch:'feat-b', isTrunk:false, parentBranch:'feat-a'}]`

Add `readGraphitePRInfo(repoPath, deps)`:
- Resolve `gitCommonDir` via `execSync('git rev-parse --git-common-dir', { cwd: repoPath })`
- Read `${gitCommonDir}/.graphite_pr_info` via `fs.readFileSync` (not async — matches the sync pattern of tryGraphite)
- Parse JSON, return `{ prInfos: [...] }` or `null` on failure
- Each `prInfo` has: `prNumber`, `headRefName`, `state`, `isDraft`, `url`

Add `enrichStackWithPRInfo(stack, prInfos)`:
- For each stack entry, find matching `prInfo` where `prInfo.headRefName === entry.branch`
- Add `prNumber` to the stack entry if found
- Returns enriched stack array

Update `detectBaseBranch()` line 43: call `tryGraphiteState` instead of `tryGraphite`. Return shape now includes optional `stack`.

Export: `{ detectBaseBranch, getDefaultBranch, buildStack, readGraphitePRInfo, enrichStackWithPRInfo }`

### 1.2 Return stack data from PR data endpoint

**File:** `src/routes/pr.js` — `GET /api/pr/:owner/:repo/:number` (line 153)

After fetching `prMetadata` and `extendedData`, if `enable_graphite` is true and worktree exists:
- Import `tryGraphiteState`, `readGraphitePRInfo`, `enrichStackWithPRInfo` from `../git/base-branch`
- Run `tryGraphiteState(worktreePath, prMetadata.head_branch, deps)` in the worktree
- If stack returned, enrich with PR info via `readGraphitePRInfo` + `enrichStackWithPRInfo`
- Add `stack_data` to the response object (after `head_sha`)

Same for the refresh endpoint response (lines 414–438).

### 1.3 Return stack data from local data endpoint

**File:** `src/routes/local.js` — `GET /api/local/:reviewId` (line 506)

After determining `branchName` (~line 538), if `enable_graphite` is true:
- Same stack detection: `tryGraphiteState(review.local_path, branchName, deps)`
- Enrich with `readGraphitePRInfo(review.local_path)` + `enrichStackWithPRInfo`
- Add `stackData` to response (after `branchAvailable`)

---

## Phase 2: Backend — Base Branch Override

### 2.1 Add `?base=<branch>` to PR diff endpoint

**File:** `src/routes/pr.js` — `GET /api/pr/:owner/:repo/:number/diff` (line 659)

- Read `req.query.base` (branch name to override as base)
- When set AND worktree exists:
  1. Resolve branch to SHA: `git.revparse([baseBranchOverride])` via simpleGit in worktree
  2. Regenerate diff with `${overrideSha}...${headSha}` (combine with `-w` if `?w=1` also set)
  3. Regenerate `changedFiles` from the same range via `diffSummary`
  4. On failure (branch not found): `logger.warn`, fall through to default base
- Restructure the existing `hideWhitespace` code path to compose with base override:
  - Both `base` and `w=1` set → regenerate with overridden base + `-w` flag
  - Only `base` set → regenerate with overridden base (no `-w`)
  - Only `w=1` set → existing behavior (regenerate with `-w`)
  - Neither → return cached diff from prData

### 2.2 Add `?base=<branch>` to local diff endpoint

**File:** `src/routes/local.js` — `GET /api/local/:reviewId/diff` (line 725)

- Read `req.query.base`
- Pass as baseBranch to `generateScopedDiff()`:
  ```
  const baseBranch = req.query.base || review.local_base_branch;
  ```
- `generateScopedDiff` already takes `baseBranch` as a parameter — direct substitution
- The base override applies regardless of scope (per user preference: selector always visible when stack detected)

---

## Phase 3: Frontend — Base Branch Selector

### 3.1 HTML: Base selector in toolbar

**File:** `public/pr.html`

After the toolbar-branch span (after ~line 198), add:
```html
<span id="base-branch-selector-wrap" class="base-branch-selector-wrap" hidden>
    <span class="toolbar-separator"></span>
    <label for="base-branch-select" class="sr-only">Compare against</label>
    <select id="base-branch-select" class="base-branch-select" title="Change base branch for diff"></select>
</span>
```

**File:** `public/local.html` — same addition in the corresponding toolbar area.

### 3.2 CSS: Selector styles

**File:** `public/css/pr.css`

```css
.base-branch-selector-wrap {
  display: inline-flex;
  align-items: center;
}
.base-branch-select {
  font-size: 0.75rem;
  padding: 2px 6px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  cursor: pointer;
  max-width: 200px;
}
```

### 3.3 JS: `renderBaseBranchSelector(pr)` on PRManager

**File:** `public/js/pr.js`

New method on PRManager:
- Gets `#base-branch-selector-wrap` and `#base-branch-select`
- Hidden if no `pr.stack_data` or `stack_data.length < 2`
- Populate `<select>` with stack ancestors (all entries except last/current branch)
- Default selection: `pr.base_branch` (the GitHub-recorded base)
- `change` listener: set `this.currentBaseOverride = select.value`, call `this.loadAndDisplayFiles()`
- Use `data-listener-added` pattern to prevent duplicate listeners
- Add `this.currentBaseOverride = null` to PRManager constructor
- Call at end of `renderPRHeader(pr)`

### 3.4 Thread base override through diff fetching

**File:** `public/js/pr.js`

In `loadAndDisplayFiles()` (line 720):
- Build URL with `URLSearchParams` including `base` when `this.currentBaseOverride` is set
- `handleWhitespaceToggle` (line 798) already calls `loadAndDisplayFiles()` — no change needed

Reset `this.currentBaseOverride = null` after refresh succeeds.

### 3.5 Local mode patches

**File:** `public/js/local.js`

In `loadLocalReview()` (~line 946):
- Set `manager.currentPR.stack_data = reviewData.stackData`

In `updateLocalHeader()`:
- Call `manager.renderBaseBranchSelector(manager.currentPR)`
- Selector visible whenever stack detected, regardless of scope

In `loadLocalDiff()` (line 1314):
- Append `&base=...` when `manager.currentBaseOverride` is set

---

## Phase 4: Tests

### 4.1 Unit tests: `tests/unit/base-branch.test.js`

- Replace existing Graphite mocks (`which gt`, `gt trunk`, `gt parent`) with single `gt state` mock
- Test `tryGraphiteState`: returns stack for 3-level chain
- Test `buildStack()` directly: ordering, cycle protection, trunk prepending
- Test `readGraphitePRInfo`: parses `.graphite_pr_info`, handles missing file
- Test `enrichStackWithPRInfo`: joins stack entries with PR info by branch name
- Test fallback when `gt state` throws
- Test missing currentBranch in gt state output

### 4.2 Integration tests: `tests/integration/routes.test.js`

- `GET /api/pr/:owner/:repo/:number` returns `stack_data` when Graphite detected
- `GET /api/pr/:owner/:repo/:number` returns no `stack_data` when Graphite not configured
- `GET /api/pr/:owner/:repo/:number/diff?base=some-branch` uses overridden base
- `GET /api/pr/:owner/:repo/:number/diff?base=nonexistent` falls through to default

### 4.3 E2E tests + test suite

- `npm test` — no regressions
- `npm run test:e2e` — frontend changes work

### 4.4 Changeset

- Create `.changeset/*.md` with `minor` bump for new feature

---

## Hazards

1. **PR diff endpoint has two code paths** (lines 704–761): `hideWhitespace + worktree` and default cached. Adding `?base=` creates a third. All three must produce identical response shape `{ diff, changed_files, stats }`. The `?base=` and `?w=1` must compose correctly.

2. **`handleWhitespaceToggle` must preserve base override.** PR mode (line 798) calls `loadAndDisplayFiles()`, local mode (line 479) calls `loadLocalDiff()`. Both will automatically include the override since they read `this.currentBaseOverride`. Verify this works.

3. **`generateScopedDiff` is called from multiple places** in local.js. The `?base=` override in the diff endpoint must not leak into scope-change or refresh flows.

4. **The refresh endpoint response** (lines 414–438) constructs its own response object separately from GET. Both must include `stack_data`.

5. **`gt state` only works when Graphite is initialized.** Pair-review's auto-cloned repos (Tier 3) won't have Graphite state. Silent fallback to null is correct.

6. **`.graphite_pr_info` may be stale.** PR numbers could be wrong if user hasn't run `gt sync` recently. Acceptable — same data `gt log` uses.

7. **Worktree git-common-dir resolution.** `.graphite_pr_info` is in `git rev-parse --git-common-dir`, NOT `git rev-parse --git-dir`. In worktrees, these differ. Must use `--git-common-dir`.

8. **`renderPRHeader` is called multiple times** (initial load, after refresh). The selector must be idempotent — remove old listeners before adding new ones.

9. **Base override for local mode when scope doesn't include branch.** Per user preference, the selector is always visible when stack detected. The diff may not reflect the override if scope is uncommitted-only, but this is acceptable — user can toggle scope independently.

10. **XSS risk.** Branch names in `<select>` options should use `textContent` or `createElement`, not innerHTML.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/git/base-branch.js` | Replace `tryGraphite()` with `tryGraphiteState()`, add `buildStack`, `readGraphitePRInfo`, `enrichStackWithPRInfo` |
| `src/routes/pr.js` | Return `stack_data` from GET + refresh endpoints. Add `?base=` to diff endpoint. |
| `src/routes/local.js` | Return `stack_data` from GET endpoint. Add `?base=` to diff endpoint. |
| `public/pr.html` | Add `#base-branch-selector-wrap` in toolbar |
| `public/local.html` | Same selector addition |
| `public/css/pr.css` | Add `.base-branch-selector-wrap`, `.base-branch-select` styles |
| `public/js/pr.js` | Add `renderBaseBranchSelector()`, thread `currentBaseOverride` through diff fetching |
| `public/js/local.js` | Patch PRManager for local mode: pass stack_data, render selector, thread override |
| `tests/unit/base-branch.test.js` | Update Graphite tests for `gt state`, add buildStack/readGraphitePRInfo/enrichStack tests |
| `tests/integration/routes.test.js` | Add stack_data and `?base=` tests |

---

## Verification

1. **Unit tests**: `npm test` — new tests for tryGraphiteState, buildStack, readGraphitePRInfo, enrichStackWithPRInfo
2. **Integration tests**: New route tests for stack_data in response and `?base=` override
3. **E2E tests**: `npm run test:e2e`
4. **Manual (Graphite repo)**: Open a stacked PR → base selector shows stack ancestors → select different base → diff changes
5. **Manual (non-Graphite repo)**: No selector visible
6. **Manual (local mode with Graphite stack)**: Base selector appears, changing it re-renders diff
