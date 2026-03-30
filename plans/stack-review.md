# Stack Review Feature

## Context

Pair-review currently reviews one PR at a time. When using Graphite stacks, reviewers need to review a sequence of related PRs. Today, each must be opened and analyzed separately — slow and disconnected.

This feature adds "Analyze Stack": the user opens any PR in a Graphite stack, clicks a split button to trigger stack analysis, selects which PRs to include, configures analysis once, and the system sequentially analyzes each PR (bottom-up) by checking out each branch in the shared worktree. Results are viewable per-PR via a stack navigator in the header.

The feature requires `enable_graphite: true` in config (same gate as existing stack detection).

---

## Design Overview

**Execution model**: Sequential analysis in a shared worktree. For each PR: checkout branch → run analysis → store results → next. The analysis config (provider, model, tier, council, executable — any type) is applied uniformly to all selected PRs.

**Data model**: No new database entity. Each PR gets its own `pr_metadata`, `reviews`, and `analysis_runs` records. Stack PRs that don't have their own worktree get a `worktrees` record pointing to the shared worktree path (the `UNIQUE(pr_number, repository)` constraint is satisfied since each PR has a different `pr_number`).

**Viewing**: Diffs and suggestions come from the database (checkout-independent). Context expansion uses `git show <baseSha>:<path>` via the object store (already checkout-independent). Navigating between stack PRs uses full page navigation to `/pr/:owner/:repo/:number`.

**Staleness**: Before starting stack analysis, bulk-fetch latest PR data from GitHub and git-fetch all relevant refs. Always analyze fresh data.

**Locking**: Worktree is locked during stack analysis to prevent concurrent git operations. Lock is checked on refresh, analysis, and other worktree-modifying operations.

---

## Phase 1: Backend Infrastructure

### 1A. Worktree Branch Checkout

**File**: `src/git/worktree.js` — add method to `GitWorktreeManager`

```js
async checkoutBranch(worktreePath, prNumber, options = {})
// options: { remote = 'origin' }
// 1. Check hasLocalChanges() — reject if dirty
// 2. Fetch: git fetch <remote> +refs/pull/<prNumber>/head:refs/remotes/<remote>/pr-<prNumber>
// 3. Reset: git reset --hard refs/remotes/<remote>/pr-<prNumber>
// 4. Return: git rev-parse HEAD (the new HEAD SHA)
```

Uses the same `pull/<N>/head` refspec as `refreshWorktree()` (line 880) but stores a persistent ref (`refs/remotes/origin/pr-N`) instead of overwriting `FETCH_HEAD`. This allows multiple PR heads to coexist in the same worktree.

Must call `resolveRemoteForPR()` for fork support, same as `refreshWorktree()`.

### 1B. Worktree Lock Manager

**File**: `src/git/worktree-lock.js` (new)

```js
class WorktreeLockManager {
  acquire(worktreePath, holderId) → boolean
  release(worktreePath, holderId) → boolean
  isLocked(worktreePath) → { locked, holderId }
}
// Export singleton instance
```

Simple in-memory `Map<worktreePath, { holderId, lockedAt }>`. Non-blocking — callers check and fail fast.

### 1C. Lock Enforcement Points

**File**: `src/routes/pr.js` — add lock checks to:
- `POST /api/pr/:owner/:repo/:number/analyses` — reject 409 if worktree locked by another holder
- `POST /api/pr/:owner/:repo/:number/refresh` — reject 409 if worktree locked
- Anywhere else that calls `refreshWorktree()` or modifies worktree state

### 1D. Stack PR Setup Utility

**File**: `src/setup/stack-setup.js` (new)

```js
async function setupStackPR({ db, owner, repo, prNumber, githubToken, worktreePath, worktreeManager })
// 1. Fetch PR data from GitHub: GitHubClient.fetchPullRequest(owner, repo, prNumber)
// 2. Fetch changed files: GitHubClient.fetchPullRequestFiles(owner, repo, prNumber)
// 3. Generate diff in worktree: worktreeManager.generateUnifiedDiff(worktreePath, prData)
//    (uses git diff base_sha...head_sha — SHA-based, works after checkout)
// 4. Get changed files: worktreeManager.getChangedFiles(worktreePath, prData)
// 5. Store via storePRData(db, prInfo, prData, diff, changedFiles, worktreePath)
//    This creates/updates pr_metadata, reviews, and worktrees records
// Returns: { reviewId, prMetadata, prData, isNew }
```

Key: this runs AFTER `checkoutBranch()` for this PR, so the worktree has the right branch checked out and all SHAs are available.

**Reuses**: `storePRData()` from `src/setup/pr-setup.js` (line 41), `GitHubClient` from `src/github/client.js`, `generateUnifiedDiff()` and `getChangedFiles()` from `GitWorktreeManager` (lines 530, 560).

---

## Phase 2: Backend Stack Orchestrator

### 2A. Stack Info Endpoint

**File**: `src/routes/pr.js` — add endpoint

```
GET /api/pr/:owner/:repo/:number/stack-info
```

Returns enriched stack data for the selection dialog. For each non-trunk stack entry with a PR number:
- Title (from `pr_metadata` if cached, otherwise fetched from GitHub API)
- Whether it has an existing review with analysis results
- Whether it has its own dedicated worktree

```json
{
  "stack": [
    { "branch": "main", "isTrunk": true },
    { "branch": "feat-base", "prNumber": 101, "title": "Base feature",
      "hasAnalysis": true, "hasOwnWorktree": true },
    { "branch": "feat-top", "prNumber": 102, "title": "Top PR",
      "hasAnalysis": false, "hasOwnWorktree": false }
  ]
}
```

This endpoint reuses the existing `tryGraphiteState()` + `enrichStackWithPRInfo()` pipeline.

### 2B. Stack Analysis Endpoint

**File**: `src/routes/stack-analysis.js` (new, mounted in `src/server.js`)

```
POST /api/pr/:owner/:repo/:number/analyses/stack
```

Request:
```json
{
  "prNumbers": [101, 102, 103],
  "analysisConfig": {
    "provider": "claude", "model": "opus", "tier": "balanced",
    "customInstructions": "...", "enabledLevels": [1, 2, 3],
    "isCouncil": false, "councilId": null, "councilConfig": null,
    "configType": "single"
  }
}
```

Response (immediate):
```json
{
  "stackAnalysisId": "uuid",
  "status": "started",
  "prAnalyses": [
    { "prNumber": 101, "status": "pending" },
    { "prNumber": 102, "status": "pending" },
    { "prNumber": 103, "status": "pending" }
  ]
}
```

### 2C. Stack Analysis Orchestrator

**File**: `src/routes/stack-analysis.js`

In-memory tracking:
```js
const activeStackAnalyses = new Map();
// key: stackAnalysisId
// value: { id, status, worktreePath, originalBranch, prStatuses: Map<prNumber, status>,
//          currentPRNumber, totalPRs, startedAt, error? }
```

Orchestrator function `executeStackAnalysis(params)`:

1. **Acquire lock**: `worktreeLock.acquire(worktreePath, stackAnalysisId)`. Fail 409 if locked.
2. **Record original HEAD**: `git rev-parse HEAD` + current branch, to restore later.
3. **Bulk fetch from GitHub**: For each selected PR, fetch latest PR data from GitHub API. Update `pr_metadata` in DB. This ensures we analyze fresh data.
4. **Git fetch all PR refs**: Single command — `git fetch origin +refs/pull/101/head:refs/remotes/origin/pr-101 +refs/pull/102/head:refs/remotes/origin/pr-102 ...`
5. **For each PR (in provided order, which is bottom-up)**:
   a. Update stack progress: broadcast on `stack-analysis:{stackAnalysisId}`
   b. Checkout branch: `worktreeManager.checkoutBranch(worktreePath, prNumber)`
   c. Setup PR if needed: `setupStackPR(...)` — creates pr_metadata, review, worktree records, generates diff
   d. Resolve analysis config: merge instructions (global + repo + request), resolve provider/model
   e. Launch analysis: call into the same code path as the existing single/council endpoints
      - For single model: create `analysis_runs` record, create `Analyzer`, call `analyzeLevel1()`
      - For council: call `launchCouncilAnalysis()` from `src/routes/analyses.js`
      - For executable: call `runExecutableAnalysis()`
   f. **Await completion** (the analysis returns a promise)
   g. Broadcast per-PR result on `stack-analysis:{stackAnalysisId}`
   h. On error: log, mark PR as failed, **continue to next PR** (don't abort the stack)
6. **Restore original branch**: `git checkout <originalBranch>` or `git reset --hard <originalSHA>`
7. **Release lock**: `worktreeLock.release(worktreePath, stackAnalysisId)`
8. **Broadcast completion**: final status on `stack-analysis:{stackAnalysisId}`

### 2D. Cancel Stack Analysis

```
POST /api/analyses/stack/:stackAnalysisId/cancel
```

1. Find the currently-running individual analysis within the stack
2. Cancel it via the existing cancellation mechanism (`cancelledAnalyses.add(analysisId)`)
3. Set a `cancelled` flag on the stack state so the orchestrator loop stops after the current PR
4. Release the worktree lock
5. Restore the original branch

### 2E. Stack Analysis Status

```
GET /api/analyses/stack/:stackAnalysisId
```

Returns current state from `activeStackAnalyses` Map. Useful for reconnection after WebSocket disconnect.

### 2F. Progress Broadcasting

WebSocket topic: `stack-analysis:{stackAnalysisId}`

Progress payload:
```json
{
  "type": "stack-progress",
  "stackAnalysisId": "uuid",
  "status": "running",
  "currentPRNumber": 102,
  "currentPRIndex": 1,
  "totalPRs": 3,
  "prStatuses": [
    { "prNumber": 101, "status": "completed", "analysisId": "uuid-1", "suggestionsCount": 5 },
    { "prNumber": 102, "status": "running", "analysisId": "uuid-2" },
    { "prNumber": 103, "status": "pending" }
  ]
}
```

Each individual PR's analysis still broadcasts on its own `analysis:{analysisId}` topic (existing infrastructure unchanged). The stack progress is an orchestration layer on top.

---

## Phase 3: Frontend — Stack Analysis Trigger

### 3A. Analyze Split Button

**File**: `public/pr.html` — modify analyze button area
**File**: `public/js/pr.js` — modify `setupEventHandlers()` and add split button logic

When `this.currentPR.stack_data` has non-trunk entries with PR numbers, wrap `#analyze-btn` in a split button container:

```html
<div class="analyze-split-container" id="analyze-split-container">
  <button class="btn btn-sm btn-secondary analyze-main" id="analyze-btn">
    <svg class="analyze-icon">...</svg>
    <span class="btn-text">Analyze</span>
  </button>
  <button class="btn btn-sm btn-secondary analyze-dropdown-toggle" id="analyze-stack-toggle">
    <svg><!-- chevron --></svg>
  </button>
  <div class="analyze-dropdown-menu" id="analyze-dropdown-menu">
    <button class="analyze-dropdown-item" id="analyze-stack-btn">
      Analyze Stack (N PRs)
    </button>
  </div>
</div>
```

When no stack is detected, the button remains unchanged.

The split button is constructed dynamically in `renderPRHeader()` when stack data is available. Follow the same event delegation pattern as the existing `SplitButton` component (`public/js/components/SplitButton.js`).

### 3B. Stack Selection Dialog

**File**: `public/js/components/StackAnalysisDialog.js` (new)

Modal showing stack PRs with checkboxes. Opens when user clicks "Analyze Stack."

```
┌─────────────────────────────────────────────────┐
│ Analyze Stack                              [X]  │
├─────────────────────────────────────────────────┤
│                                                 │
│ [Select All] [Select None]                      │
│                                                 │
│ [✓] #101  Base feature          feature-base    │
│ [✓] #102  Middle PR             feature-mid     │
│ [✓] #103  Top PR (current)      feature-top  ★  │
│                                                 │
│ Bottom-up order: analysis starts from #101      │
│                                                 │
├─────────────────────────────────────────────────┤
│               [Cancel]  [Configure & Analyze]   │
└─────────────────────────────────────────────────┘
```

Behavior:
- On open: calls `GET /api/pr/:owner/:repo/:number/stack-info` to get PR titles and status
- Shows loading state while fetching
- Non-trunk PRs are pre-checked. Current PR is marked with a star.
- PRs with existing analysis shown with a subtle indicator
- "Configure & Analyze" opens `AnalysisConfigModal` (reusing the existing modal as-is)
- After user picks analysis config, calls `startStackAnalysis()`

Returns a promise resolving to `{ selectedPRNumbers, analysisConfig }` or `null` if cancelled.

### 3C. Stack Analysis Launch

**File**: `public/js/pr.js` — new method

```js
async startStackAnalysis(owner, repo, number, config) {
  // 1. POST /api/pr/:owner/:repo/:number/analyses/stack
  // 2. Open StackProgressModal with stackAnalysisId
  // 3. Subscribe to stack-analysis:{stackAnalysisId} WebSocket topic
}
```

Wire this into the existing `triggerAIAnalysis()` flow: after the stack dialog returns selected PRs, open `AnalysisConfigModal`, then call `startStackAnalysis()` instead of `startAnalysis()`.

---

## Phase 4: Frontend — Stack Progress Modal

### 4A. StackProgressModal Component

**File**: `public/js/components/StackProgressModal.js` (new)

Displays per-PR progress during stack analysis. Structure:

```
┌─────────────────────────────────────────────────┐
│ Stack Analysis Progress                    [X]  │
├─────────────────────────────────────────────────┤
│                                                 │
│ ✓  PR #101: Base feature        5 suggestions   │
│ ⟳  PR #102: Middle PR           Level 2...      │
│ ○  PR #103: Top PR              Pending         │
│                                                 │
├─────────────────────────────────────────────────┤
│       [Cancel]            [Run in Background]   │
└─────────────────────────────────────────────────┘
```

Implementation:
- Subscribe to `stack-analysis:{stackAnalysisId}` for overall progress
- For the currently-running PR, also subscribe to `analysis:{analysisId}` and show inline level detail (reuse the level rendering logic from `CouncilProgressModal`)
- "Run in Background" minimizes modal (analysis continues server-side)
- On completion, completed PRs become links to navigate to that PR's review page
- On error for a specific PR, show error inline but don't collapse the whole modal

### 4B. Integration

**File**: `public/pr.html` — add `<script src="/js/components/StackProgressModal.js"></script>`
**File**: `public/js/pr.js` — instantiate `this.stackProgressModal` in constructor

---

## Phase 5: Frontend — Stack Navigation

### 5A. PR Title Dropdown

**File**: `public/js/pr.js` — modify `renderPRHeader()`

When `stack_data` exists and has multiple PRs with `prNumber`:
- Replace the static `#pr-title-text` with a clickable dropdown trigger
- Add a small chevron icon indicating it's a selector
- Dropdown lists all stack PRs (trunk excluded) in stack order:
  - PR number, title, branch name
  - Analysis status indicator: none / has results
  - Current PR highlighted/bold
- Clicking a different PR navigates to `/pr/:owner/:repo/:prNumber`

```html
<div class="stack-nav-dropdown">
  <button class="stack-nav-trigger">
    <h1 id="pr-title-text">Current PR Title</h1>
    <svg class="stack-nav-chevron"><!-- chevron-down --></svg>
  </button>
  <div class="stack-nav-menu">
    <div class="stack-nav-item" data-pr="101">
      <span class="stack-nav-status analyzed"></span>
      <span class="stack-nav-number">#101</span>
      <span class="stack-nav-title">Base feature</span>
    </div>
    <!-- ... -->
  </div>
</div>
```

### 5B. Styles

**File**: `public/css/pr.css` — add styles for:
- `.analyze-split-container` (split button layout)
- `.analyze-dropdown-menu` (dropdown panel)
- `.stack-nav-dropdown`, `.stack-nav-trigger`, `.stack-nav-menu`, `.stack-nav-item`
- Status indicators (dot colors for analyzed / not analyzed)
- Dark theme variants

---

## Hazards

1. **`worktrees` table path overwrite**: `WorktreeRepository.getOrCreate()` updates the `path` field on existing records. When `setupStackPR()` calls `storePRData()` for a PR that already has its own dedicated worktree, the path gets overwritten to the shared worktree path. **Mitigation**: Before the stack analysis loop, snapshot all existing worktree records for the selected PRs. After stack analysis completes, restore original paths for PRs that had a *different* worktree path. PRs that had no worktree record before keep the shared path.

2. **`refreshWorktree()` during stack analysis**: If triggered (by user clicking refresh or by auto-refresh), it would corrupt the analysis. **Mitigation**: Lock check in the refresh endpoint (Phase 1C). Return 409 with message "Worktree is in use by stack analysis."

3. **Concurrent single-PR analysis during stack analysis**: The existing `POST .../analyses` endpoint doesn't check for worktree locks. **Mitigation**: Add lock check (Phase 1C).

4. **User navigates to a stack PR that has a shared worktree record**: The `GET /api/pr/:owner/:repo/:number` endpoint calls `refreshWorktree()` if the worktree exists. During stack analysis, this would fail (locked). Outside stack analysis, it would checkout that PR's branch — which is correct behavior (the user is now viewing that PR).

5. **Stack analysis failure mid-sequence**: If PR 2 of 3 fails, we continue to PR 3. The failed PR is marked with an error in the progress. The user can retry individually later. The worktree lock is released and original branch restored even on partial failure (finally block).

6. **`resolveRemoteForPR()` for fork PRs**: Stack PRs may be from a fork. `checkoutBranch()` must resolve the correct remote, same as `refreshWorktree()`. **Mitigation**: Accept prData/prInfo params in `checkoutBranch()` and call `resolveRemoteForPR()`.

7. **Three analysis code paths in `src/ai/analyzer.js`**: `analyzeAllLevels`, `runReviewerCentricCouncil`, `runCouncilAnalysis`. The stack orchestrator calls these via existing route-level wrappers, not directly. No changes needed to the analyzer. The orchestrator extracts and reuses the analysis launch logic from the existing endpoints.

8. **Context expansion for stack PRs**: The file content API at `src/routes/reviews.js:928` uses `git show ${baseSha}:${fileName}` via the object store. This is checkout-independent and works correctly for stack PRs sharing a worktree. **No change needed**.

9. **WebSocket reconnection**: If the user's connection drops during stack analysis, they lose progress updates. **Mitigation**: `GET /api/analyses/stack/:stackAnalysisId` endpoint for polling/reconnection. The frontend re-subscribes on WebSocket reconnect.

---

## Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `tests/unit/worktree-checkout.test.js` | `checkoutBranch()` — fetches correct ref, resets, rejects on dirty worktree, resolves remote for forks |
| `tests/unit/worktree-lock.test.js` | acquire/release lifecycle, reject double-acquire by different holder, allow re-acquire by same holder, `isLocked()` state |
| `tests/unit/stack-setup.test.js` | `setupStackPR()` — creates metadata + review + worktree records, handles already-existing records, generates correct diff |
| `tests/unit/stack-orchestrator.test.js` | `executeStackAnalysis()` — sequential execution order, continues on per-PR failure, restores original branch and worktree records, releases lock on error |

### Integration Tests

| Test File | Coverage |
|-----------|----------|
| `tests/integration/stack-analysis.test.js` | `POST .../analyses/stack` returns stackAnalysisId, rejects when locked, `GET .../stack-info` returns enriched data, `POST .../cancel` stops execution |

### E2E Tests

| Test File | Coverage |
|-----------|----------|
| `tests/e2e/stack-analysis.spec.js` | Split button appears when stack detected, stack dialog shows PRs, progress modal displays, navigation dropdown works |

### Schema Updates

- `tests/e2e/global-setup.js` — ensure test DB schema matches production
- `tests/integration/routes.test.js` — same

---

## Verification

1. **Phase 1 done**: `npm test -- tests/unit/worktree-checkout.test.js tests/unit/worktree-lock.test.js` passes. Manual: `checkoutBranch()` on a real worktree with `git log -1` confirming the right commit.

2. **Phase 2 done**: `npm test -- tests/unit/stack-orchestrator.test.js tests/integration/stack-analysis.test.js` passes. Manual: curl `POST .../analyses/stack` with a known Graphite stack, observe sequential analysis completing.

3. **Phase 3 done**: Open a PR in a Graphite stack in the browser. Verify split button appears. Click "Analyze Stack", verify dialog shows PR list with titles. Select PRs, configure, and start.

4. **Phase 4 done**: Trigger stack analysis from UI. Verify progress modal shows per-PR rows with live updates. Verify "Run in Background" works. Verify completed PRs are navigable.

5. **Phase 5 done**: After stack analysis, verify PR title becomes a dropdown showing all stack PRs. Click another PR, verify navigation to that PR's review page with its diff and suggestions displayed.

6. **Full E2E**: `npm run test:e2e -- tests/e2e/stack-analysis.spec.js` passes.

---

## File Inventory

### New Files
| File | Purpose |
|------|---------|
| `src/git/worktree-lock.js` | In-memory worktree lock manager |
| `src/setup/stack-setup.js` | Lightweight PR setup for stack members |
| `src/routes/stack-analysis.js` | Stack orchestrator, endpoints, in-memory state |
| `public/js/components/StackAnalysisDialog.js` | PR selection dialog |
| `public/js/components/StackProgressModal.js` | Stack-level progress modal |
| `tests/unit/worktree-checkout.test.js` | Branch checkout unit tests |
| `tests/unit/worktree-lock.test.js` | Lock manager unit tests |
| `tests/unit/stack-setup.test.js` | Stack PR setup unit tests |
| `tests/unit/stack-orchestrator.test.js` | Orchestrator unit tests |
| `tests/integration/stack-analysis.test.js` | Stack endpoint integration tests |
| `tests/e2e/stack-analysis.spec.js` | Full flow E2E tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/git/worktree.js` | Add `checkoutBranch()` method |
| `src/routes/pr.js` | Add `GET .../stack-info` endpoint, lock checks on analysis/refresh |
| `src/routes/shared.js` | Export `activeStackAnalyses` Map, add stack progress broadcasting |
| `src/server.js` | Mount stack-analysis router |
| `public/pr.html` | Add StackAnalysisDialog.js and StackProgressModal.js script tags |
| `public/js/pr.js` | Split button in `renderPRHeader()`, `triggerStackAnalysis()`, stack nav dropdown |
| `public/css/pr.css` | Split button styles, stack nav dropdown styles, progress modal styles |
| `tests/e2e/global-setup.js` | Ensure test schema matches production |
| `tests/integration/routes.test.js` | Add schema updates if needed |

### Key Existing Code to Reuse
| Code | Location | Reuse |
|------|----------|-------|
| `tryGraphiteState()` + `enrichStackWithPRInfo()` | `src/git/base-branch.js` | Stack detection in stack-info endpoint |
| `storePRData()` | `src/setup/pr-setup.js:41` | PR metadata + review creation in setupStackPR |
| `generateUnifiedDiff()` | `src/git/worktree.js:530` | Diff generation per stack PR |
| `getChangedFiles()` | `src/git/worktree.js:560` | Changed file list per stack PR |
| `launchCouncilAnalysis()` | `src/routes/analyses.js` | Council analysis within stack |
| `createProgressCallback()` | `src/routes/shared.js` | Per-PR progress during stack analysis |
| `resolveRemoteForPR()` | `src/git/worktree.js` | Fork handling in checkoutBranch |
| `AnalysisConfigModal` | `public/js/components/AnalysisConfigModal.js` | Reused as-is for config selection |
| `SplitButton` patterns | `public/js/components/SplitButton.js` | Reference for split button implementation |
