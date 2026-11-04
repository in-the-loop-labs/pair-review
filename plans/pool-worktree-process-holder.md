# Pool worktrees record the process that holds them (#632)

## Problem

Several pair-review processes can share one SQLite database (two `--headless`
runs, or a headless run beside the server). `worktree_pool` rows have no owning
process, and every process assumes it is the only one:

1. **Startup cleanup** (`WorktreePoolRepository.resetStaleAndPreserve`, called by
   `WorktreePoolLifecycle.resetAndRehydrate` from `src/main.js` and `src/server.js`)
   deletes `creating` rows, resets `switching` rows, and resets `in_use` rows with
   no review owner. Those are exactly the states of a worktree another live
   process is preparing.
2. **Idle release**: startup also keeps `in_use` rows that have a review owner and
   arms a 30s grace timer for them in its own in-memory tracker. That tracker
   never sees the other process's analysis, so the timer fires and the
   unconditional `markAvailable` frees a worktree the other process is using.

Either way a third claimant can switch the checkout to a different PR under a
running review.

## Scope

**In scope:** a worktree being prepared or used by one live process must not be
freed by another process, and must not be handed to a review of a **different
PR**. Plus two same-process races found in review that also end with two PRs in
one directory (see "Acquire-time races").

**Out of scope (do not change):**
- Two processes reviewing the **same PR** sharing one pool worktree. `claimByPR`
  keeps sharing it and moves the holder to the newest claimer. The first one to
  finish can still free it under the other. This is not a regression (`main`
  frees unconditionally) and is tracked as a separate follow-up.
- The setup and `/pr` fast paths that hand an `in_use` row to the browser.
- User-initiated deletes (`releaseForDeletion`, `destroyPoolWorktree`, the
  worktree routes): keep `main`'s behaviour; no peer refusals, no new 409s.
- Frontend code.
- Holder bookkeeping for WebSocket sessions, reconnects or analyses.

## Design

### Schema
Migration 59 adds two nullable columns to `worktree_pool`: `holder_pid INTEGER`
and `holder_claimed_at TEXT`. Each `ALTER` is guarded by `columnExists`; skip if
the table is missing. Update `SCHEMA_SQL` and `tests/utils/schema.js`. Existing
rows get NULL holders, which startup treats as dead.

### Liveness (`src/utils/process-liveness.js`, new)
- `isProcessAlive(pid, _deps)`: `process.kill(pid, 0)`. Invalid pid → false;
  success → true; `ESRCH` → false; `EPERM` and any other error → true
  (uncertain means alive).
- `getBootTimeMs(_deps)`: `Date.now() - os.uptime() * 1000`.

### Repository (`WorktreePoolRepository`)
Every holder-taking method requires a positive-integer `holderPid` (TypeError
otherwise). The repository never reads `process.pid`.

| Method | Change |
|---|---|
| `reserveSlot(id, repo, size, holderPid)` | Insert `creating` row with holder. |
| `finalizeReservation(id, path, pr, holderPid)` | Also require `holder_pid = holderPid`; return boolean. |
| `claimAvailable(repo, holderPid)` | `switching` + holder = self. |
| `claimByPR(pr, repo, holderPid)` | Holder = self. If the row was held by a different pid, return that pid as `previousHolderPid` so the lifecycle can log it. |
| `create({..., prNumber, holderPid})` | `in_use` insert stamps holder; `available` insert has none. |
| `reclaimAvailableForPR(id, pr, holderPid)` (new) | Atomic `UPDATE … WHERE id = ? AND status = 'available' AND current_pr_number = ?`; holder = self; boolean. |
| `markInUse(id, pr, holderPid, fromStatus)` | **Conditional.** `fromStatus = 'switching'`: require `status = 'switching' AND holder_pid = holderPid`. `fromStatus = 'in_use'` (refresh): require `status = 'in_use' AND current_pr_number = pr AND holder_pid = holderPid`. Return boolean. |
| `markAvailable(id, holderPid)` | Require `status = 'in_use' AND holder_pid = holderPid`; clear review + holder; boolean. |
| `abandonSwitch(id, holderPid)` (new) | Require `status = 'switching' AND holder_pid = holderPid`; → `available`, clear review + holder; boolean. |
| `forceMarkAvailable(id)` (new) | Unconditional; clear review + holder. Only for `releaseForDeletion`. |
| `resetStaleAndPreserve(selfPid, isHolderDead)` | One IMMEDIATE transaction. For each non-available row: if `!isHolderDead(row)` skip it (no write, not returned). Dead holder: `creating` → delete; `in_use` with an existing review → holder = self, return it; otherwise → `available`, clear review + holder. |
| `markSwitching` | Delete (no production caller). |

### Lifecycle (`WorktreePoolLifecycle`)
- New `_deps`: `pid` (default `process.pid`), `isProcessAlive`, `getBootTimeMs`.
- `_isHolderDeadAtStartup(row, bootTimeMs)`: dead if `holder_pid` is NULL; or
  equals this pid (a just-started process holds nothing, so its pid on a row
  means a reused pid); or `holder_claimed_at` is missing, unparseable or before
  boot; else `!isProcessAlive(holder_pid)`. Used **only** at startup; there is
  no runtime liveness check in this change.
- All claims pass `this._pid`. `claimByPR` logs at info when
  `previousHolderPid` is set: "taking over pool worktree X from pid N (same PR)".
- `release()`: delete (no production caller).
- `releaseForDeletion`: clear tracker, then `forceMarkAvailable` (as `main`).
- `releaseAfterHeadless`: clear tracker, then `markAvailable(id, self)`;
  **return** the boolean. Its callers (`src/main.js` ×3, `src/setup/pr-setup.js`)
  word their log line from it.
- `onIdle`: `markAvailable(id, self)`; if false, log at info and do not retry.
- `_switchPoolWorktree` rollback: `abandonSwitch(id, self)`.
- `reclaimForPR(id, pr)` (new): calls `reclaimAvailableForPR`; `src/routes/setup.js`
  uses it instead of `poolRepo.markInUse`, and falls through to normal setup
  when it returns false.

### Acquire-time races (same process, end with two PRs in one directory)
1. **Grace timer fires mid-acquire.** A pending grace timer for a row this
   process is now claiming can fire during the long fetch in
   `_refreshPoolWorktree`/`_switchPoolWorktree` and free the row; a peer claims
   it for another PR; the unconditional `markInUse` then forced it back.
   Fix: add `cancelGrace(worktreeId)` to `WorktreePoolUsageTracker` (cancels a
   pending timer only; sessions and analyses untouched) and call it in
   `acquireForPR` right after `claimByPR` / `claimAvailable` succeed. The
   conditional `markInUse` is the backstop: if it returns false, throw
   ("pool worktree X was taken over during refresh/switch").
2. **Refresh failure leaks the claim.** Wrap the `_refreshPoolWorktree` call in
   `acquireForPR`: on error, if `!this._usageTracker.isInUse(id)` **and the claim
   did not take the row from another process** (`previousHolderPid` is null),
   call `markAvailable(id, self)` (gated, best effort, log failures); rethrow.
   A row taken from a peer stays `in_use`: that peer may still be serving the
   PR and this tracker cannot see it (on `main` a failed refresh released
   nothing). If the peer is actually dead, the next startup reclaims the row.

## Tests (same change)
- `tests/unit/process-liveness.test.js`: invalid pid, success, ESRCH, EPERM,
  other error; boot time.
- Repository: holder stamped by every claim; each conditional method succeeds
  only in its exact precondition and leaves the row byte-identical otherwise
  (assert full rows with `toEqual`, and assert holder columns with `=== null`
  / `toBe`); reset skips live rows in all of `creating`, `switching`,
  `in_use` without review, `in_use` with review; reset handles dead rows as
  before and takes over preserved ones; legacy NULL-holder `in_use` row with a
  live review is taken over and can then be released by self; predicate
  returning false leaves a legacy row untouched.
- Lifecycle unit: call the predicate captured from `resetStaleAndPreserve`
  (not `expect.any(Function)`): own pid with a recent claim is dead, live peer
  alive, dead peer dead, pre-boot claim dead. Mocks for `finalizeReservation`
  and `markAvailable` resolve `true`; one test asserts the warning when
  `finalizeReservation` returns false.
- Lifecycle, two processes on one real test DB, injected pids, fake timers,
  each process calling `resetAndRehydrate()` **before** `acquireForPR`:
  (a) B starts while A is `creating`, `switching`, and `in_use` before
  `setReviewOwner` → B cannot claim A's row for a different PR, including when
  B requests the PR the row carries (so `claimByPR`'s status filter is
  exercised); (b) B starts after A set the review owner, B has a real session
  that it removes so a timer is armed, timers run → A's row is still `in_use`
  held by A.
- Acquire races: a pending grace timer is cancelled by a claim (timers run
  during a held refresh → row not freed); `markInUse` returning false makes
  `acquireForPR` throw; refresh throws → row freed when not in use, kept when
  the tracker has a session.
- `tests/integration/setup-routes.test.js`: reclaim race — spy on
  `reclaimForPR`, assert it was called with `('pool-abc', 42)` and resolved
  `false`, and the peer's row is unchanged.
- Migration 59 in `tests/integration/database.test.js`; bump the expected
  version in `tests/integration/comment-postings.test.js`.

## Changeset
`patch`: "A pair-review process starting up, or going idle, no longer frees or
reassigns a pool worktree that another running pair-review process is preparing
or using for a different PR."

## Hazards
- `markInUse` callers: `_switchPoolWorktree` (`fromStatus 'switching'`),
  `_refreshPoolWorktree` ×2 (`'in_use'`), and `src/routes/setup.js` (replaced by
  `reclaimForPR`). Grep for any other caller, including tests.
- `markAvailable` callers on `main`: switch rollback (→ `abandonSwitch`),
  `release()` (deleted), `releaseForDeletion` (→ `forceMarkAvailable`),
  `releaseAfterHeadless` and `onIdle` (gated). Grep tests too.
- `releaseAfterHeadless` must keep clearing the tracker **before** the DB write.
- `resetAndRehydrate` must run before the process acquires anything (true in
  `main.js` and `server.js`); the own-pid rule depends on it. Say so in its JSDoc.
- Between `acquireForPR` and `setReviewOwner` the row is `in_use` with a NULL
  review; only the live-holder check protects it from a peer's startup.
- `claimByPR` still takes a same-PR row from a live peer (out of scope; logged).
