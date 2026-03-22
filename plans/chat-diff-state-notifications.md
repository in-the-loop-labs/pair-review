# Plan: Diff State Change Notifications for Chat Agent

## Context

The chat agent frequently gets confused about whether the diff has changed during a review session. When the PR HEAD updates, the working directory changes, or the user switches diff scope in local mode, the agent continues operating on stale assumptions. This leads to incorrect suggestions and wasted user effort correcting the agent.

**Goal**: When the diff state changes, queue an invisible notification that gets prepended to the agent's next message via the existing `context` parameter. No polling — only fire when changes are already detected (page load staleness check or explicit refresh/scope change).

---

## Files to Modify

| File | Changes |
|------|---------|
| `public/js/components/ChatPanel.js` | Add `_pendingDiffStateNotifications` queue, drain in `sendMessage()`, public `queueDiffStateNotification()` method |
| `public/js/pr.js` | Queue notifications from `_checkStalenessOnLoad()` and `refreshPR()` |
| `public/js/local.js` | Queue notifications from `_checkLocalStalenessOnLoad()`, `refreshDiff()`, `_handleScopeChange()`, `showBranchReviewDialog()` |
| `src/routes/local.js` | Expand check-stale and refresh endpoints to always report HEAD SHA changes |

No changes needed to backend chat routes or session-manager — notifications flow through existing `context` parameter.

---

## Step 1: Backend — Always report HEAD SHA changes in local endpoints

### 1a. `GET /api/local/:reviewId/check-stale` (src/routes/local.js:777)

Currently only checks HEAD SHA when `includesBranch(scopeStart)` (line 810). Change to **always** check HEAD SHA and return it as supplementary fields. Only use HEAD SHA mismatch to set `isStale: true` when branch is in scope (preserving current behavior for badge/auto-refresh). The digest check still runs for all scopes.

```
Response shape (after change):
{
  isStale: boolean,
  storedDigest, currentDigest,           // existing (when digest checked)
  headShaChanged: boolean,               // NEW — always present
  storedSha: string | null,              // NEW — always present
  currentSha: string | null              // NEW — always present
}
```

Move the HEAD SHA check before the `includesBranch` guard. Always compute `headShaChanged`. If branch is in scope AND head changed → early return with `isStale: true` (existing behavior). Otherwise, continue to digest check and include `headShaChanged` in the response.

### 1b. `POST /api/local/:reviewId/refresh` (src/routes/local.js:1252)

Currently `newHeadSha` is only returned when `sessionChanged` is true (line 1356). For branch scope, HEAD can change silently (lines 1299-1303) with no indication in the response.

Add `headShaChanged` and always return both SHAs in the response:

```
Response shape (after change):
{
  success, message, sessionChanged, newSessionId,
  headShaChanged: boolean,               // NEW
  previousHeadSha: string,               // RENAME from originalHeadSha
  currentHeadSha: string,                // NEW — always present
  stats
}
```

Keep `originalHeadSha` as an alias for backwards compat with existing frontend code that reads it (local.js:665).

---

## Step 2: ChatPanel — Queue mechanism

### File: `public/js/components/ChatPanel.js`

### 2a. Constructor (line ~37)
Add: `this._pendingDiffStateNotifications = [];`

### 2b. New public method
```js
queueDiffStateNotification(message) {
  this._pendingDiffStateNotifications.push(message);
}
```

### 2c. `sendMessage()` (line ~1242)
After `const payload = { content };`, before the `_pendingContext` block:

1. Snapshot the queue for error recovery: `const savedDiffState = this._pendingDiffStateNotifications.slice();`
2. Drain the queue into a `diffStatePrefix` string:
   ```
   let diffStatePrefix = '';
   if (this._pendingDiffStateNotifications.length > 0) {
     diffStatePrefix = '[Diff State Update]\n' +
       this._pendingDiffStateNotifications.join('\n');
     this._pendingDiffStateNotifications = [];
   }
   ```
3. Merge into `payload.context` — diff state prefix comes before any "Ask about this" context:
   - If `_pendingContext` has items → `payload.context = diffStatePrefix + '\n\n' + userContext` (or just `userContext` if no prefix)
   - If only diff state → `payload.context = diffStatePrefix`
4. In the `catch` block (line ~1319), restore: `this._pendingDiffStateNotifications = savedDiffState;`

### 2d. Lifecycle cleanup
- `_startNewConversation()` (line 649): Clear `this._pendingDiffStateNotifications = [];` — fresh agent has no prior context to correct.
- `close()` (line 604): Do **NOT** clear. Diff state actually changed; notification should survive panel close/reopen.

---

## Step 3: PR mode notifications

### File: `public/js/pr.js`

### 3a. `_checkStalenessOnLoad()` (line 4399)

After `if (result.isStale !== true) return result;` (line 4411), inside the `if (hasData)` branch only (line 4415-4416). Do NOT queue in the auto-refresh branch — `refreshPR()` will queue its own notification to avoid duplicates.

```js
if (window.chatPanel) {
  const oldSha = result.localHeadSha ? result.localHeadSha.substring(0, 7) : 'unknown';
  const newSha = result.remoteHeadSha ? result.remoteHeadSha.substring(0, 7) : 'unknown';
  window.chatPanel.queueDiffStateNotification(
    `PR HEAD has changed (${oldSha} → ${newSha}). The diff has not been refreshed yet.`
  );
}
```

### 3b. `refreshPR()` (line 4515)

Capture old SHA before refresh: `const oldHeadSha = this.currentPR?.head_sha;`

After `this.currentPR = data.data;` (line 4550):
```js
const newHeadSha = data.data?.head_sha;
if (window.chatPanel && oldHeadSha && newHeadSha && oldHeadSha !== newHeadSha) {
  window.chatPanel.queueDiffStateNotification(
    `PR refreshed. HEAD changed: ${oldHeadSha.substring(0, 7)} → ${newHeadSha.substring(0, 7)}.`
  );
}
```

---

## Step 4: Local mode notifications

### File: `public/js/local.js`

### 4a. `_checkLocalStalenessOnLoad()` (line 750)

After `if (result.isStale !== true)` (line 755), check for HEAD SHA change even when digest says not stale:
```js
if (result.headShaChanged && window.chatPanel) {
  window.chatPanel.queueDiffStateNotification(
    `HEAD SHA changed (${result.storedSha?.substring(0, 7)} → ${result.currentSha?.substring(0, 7)}). The branch may have been rebased.`
  );
}
if (result.isStale !== true) return result;
```

In the `if (hasData)` branch (line 760), queue the staleness notification (not in auto-refresh branch to avoid duplicates with `refreshDiff()`):
```js
if (window.chatPanel) {
  window.chatPanel.queueDiffStateNotification(
    'Working directory has changed since the diff was captured.'
  );
}
```

### 4b. `refreshDiff()` (line 639)

After the session-changed dialog block (line ~700), before `await this.loadLocalDiff()` (line 703):

```js
if (window.chatPanel) {
  if (result.headShaChanged) {
    const prev = result.previousHeadSha || result.originalHeadSha;
    window.chatPanel.queueDiffStateNotification(
      `HEAD SHA changed: ${prev?.substring(0, 7)} → ${result.currentHeadSha?.substring(0, 7)}.`
    );
  }
  window.chatPanel.queueDiffStateNotification(
    'Local diff refreshed from working directory.'
  );
}
```

Note: if user chose "Switch to New Session", page redirects (line 679) and notification is lost. Correct — new page starts fresh.

### 4c. `_handleScopeChange()` (line 1391)

After `await this._applyScopeResult(...)` (line 1410):
```js
if (window.chatPanel) {
  const LS = window.LocalScope;
  const label = LS ? LS.scopeLabel(scopeStart, scopeEnd) : `${scopeStart}–${scopeEnd}`;
  window.chatPanel.queueDiffStateNotification(
    `Diff scope changed to ${label}. The set of reviewed files has changed.`
  );
}
```

### 4d. `showBranchReviewDialog()` confirm handler (line ~1538)

After `await self._applyScopeResult('branch', newEnd, result);`:
```js
if (window.chatPanel) {
  const LS = window.LocalScope;
  const label = LS ? LS.scopeLabel('branch', newEnd) : 'branch';
  window.chatPanel.queueDiffStateNotification(
    `Diff scope changed to ${label} via branch review. The set of reviewed files has changed.`
  );
}
```

---

## Notification Format

When multiple notifications queue up, they collapse under one header:

```
[Diff State Update]
HEAD SHA changed: abc1234 → def5678.
Local diff refreshed from working directory.
```

This flows through the existing `context` parameter and gets prepended to the user message in session-manager (line 130). The `[Diff State Update]` bracket prefix signals system metadata, matching the existing `[Action: ...]` pattern.

---

## Hazards

1. **`_applyScopeResult` has two callers**: `_handleScopeChange` (line 1410) and `showBranchReviewDialog` (line 1538). Notifications are added at each call site, NOT inside `_applyScopeResult`, because each call site knows the human-readable reason. Both callers must be updated.

2. **`sendMessage()` error recovery**: `_pendingContext` is restored on send failure (line 1319). The same must happen for `_pendingDiffStateNotifications`. Snapshot before draining, restore in catch.

3. **Duplicate notifications on auto-refresh path**: `_checkStalenessOnLoad` (PR) auto-calls `refreshPR()` and `_checkLocalStalenessOnLoad` auto-calls `refreshDiff()`. Queue staleness notification only in the `hasData` (badge-shown) branch to avoid duplicates with the refresh method's own notification.

4. **Local refresh `originalHeadSha` backwards compat**: Frontend local.js reads `result.originalHeadSha` (line 665). Keep that field in the response; add `previousHeadSha` and `currentHeadSha` as new fields.

5. **Race: staleness check vs. early user message**: Staleness check is async fire-and-forget. If user sends a message before it completes, the notification won't be queued yet. Acceptable — no polling, next refresh catches it.

6. **`close()` intentionally does NOT clear diff state queue**: Unlike `_pendingContext` (cleared on close, line 604), diff state notifications survive close/reopen. The diff actually changed regardless of panel visibility. `_startNewConversation()` DOES clear them — fresh session needs no correction.

---

## Verification

1. **Unit tests**: Test `queueDiffStateNotification()`, drain in `sendMessage()`, merge with `_pendingContext`, error recovery, lifecycle cleanup
2. **PR mode manual test**: Open a PR, push a new commit from another terminal, refresh → verify notification appears in next chat message's context (check network tab for `context` field in POST body)
3. **Local mode manual test**:
   - Edit a file, click refresh → verify "diff refreshed" notification
   - Change scope dropdown → verify "scope changed" notification
   - Make a commit, refresh → verify HEAD SHA notification
4. **E2E tests**: Run `npm run test:e2e` after changes
