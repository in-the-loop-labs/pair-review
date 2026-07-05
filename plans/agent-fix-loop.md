# Agent Fix Loop: Dispatch Adopted Comments → Agent Fixes → Verified Resolution

## Vision

Pair-review's thesis is a tight feedback loop between a human reviewer and an AI
coding agent. Today the loop closes by hand: the user adopts suggestions, then
copies feedback out (or points an agent at the MCP tools) and waits, then
manually re-reviews whatever came back. This plan makes the loop a first-class,
one-click workflow:

1. User adopts/writes comments as usual.
2. User clicks **Fix these** (all active user comments) or **Fix this** (one
   comment's action bar).
3. Pair-review dispatches the selected comments to a coding agent running with
   edit permissions in the review's working directory (PR worktree or local
   tree). The agent's activity streams live in the existing ChatPanel.
4. When the agent finishes, pair-review snapshots the result, re-diffs, and
   shows an **interdiff** — only what the agent changed.
5. A per-comment **verification pass** judges each dispatched comment against
   the delta: `addressed` / `partially addressed` / `not addressed`.
6. The user confirms each verdict: addressed comments resolve (with a link to
   the fixing change); bounced comments return to `active` with the verifier's
   explanation attached, ready for another round or manual handling.

The human never loses control: the agent's changes are always inspectable as a
diff before anything is accepted, every workspace mutation is preceded by a
snapshot that can be restored, and nothing is pushed anywhere.

## What already exists (recon summary, verified 2026-07-04)

- **Headless agent sessions.** `ChatSessionManager.createSession()`
  (`src/chat/session-manager.js:46`) has no UI dependency; WS broadcast is
  layered on separately in `src/routes/chat.js:138`. A fix session can be
  driven entirely server-side while still streaming to the browser.
- **Correct cwd for free.** `resolveReviewCwd` (`src/routes/chat.js:60-76`)
  already resolves PR reviews to the worktree and local reviews to
  `review.local_path`, and every bridge spawns with that cwd.
- **Bridges are deliberately read-only today.** Claude Code bridge allowlist is
  `Read,Bash,Grep,Glob,Agent` (`src/chat/claude-code-bridge.js:23`) — no
  Edit/Write. Codex bridge declines `fileChange`/`applyPatch` approvals
  (`src/chat/codex-bridge.js:738-748`) despite a `workspace-write` sandbox.
  ACP bridge blanket-approves (`src/chat/acp-bridge.js:435-453`), so ACP agents
  can already edit — an inconsistency this plan makes explicit and configurable.
- **Adoption is already a linked data model.** `adoptSuggestion`
  (`src/database.js:3458`) creates a user comment with `parent_id` → the AI
  suggestion; the suggestion gets `status='adopted'`, `adopted_as_id` → the
  user comment. Dispatch payloads can carry both the human's wording and the
  original AI reasoning.
- **Payload formatting exists.** `src/chat/prompt-builder.js` already formats
  suggestions as structured JSON context; the MCP `get_user_comments` tool
  already frames comments as "actionable feedback to fix and iterate."
- **Refresh/staleness plumbing exists.** PR refresh + `_rerenderAllOverlays`
  (`public/js/pr.js:1044,8349`), local `resolve-head-change`
  (`src/routes/local.js`), and chat `[Diff State Update]` notifications.
- **Background job + WS progress plumbing exists** (`src/ai/background-queue.js`).
- **Verification precedent exists**: the consolidation/orchestration prompts
  already do "compare finding sets and exclude what's handled"
  (`plans/exclude-previous-findings.md`), which is the same judgment shape as
  "was this comment addressed by this delta?"

## What does NOT exist (the actual work)

1. An edit-capable permission profile for bridges.
2. A dispatch data model (which comments went out, in which round, with what
   outcome) and APIs for both modes.
3. Workspace safety: snapshot/restore, and surviving the PR worktree pool's
   `reset --hard` + `clean -fd` on reuse.
4. Interdiff computation and display.
5. The per-comment verification pass and the resolution state machine.

---

## Design

### New concept: Fix Round

A **fix round** is one dispatch cycle: a set of comments, one agent session,
one workspace delta, one verification pass. Rounds are append-only history —
a comment can go through multiple rounds.

**Schema (migration):**

```sql
CREATE TABLE fix_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  chat_session_id TEXT,                -- the agent session that did the work
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatching'
    CHECK (status IN ('dispatching','fixing','diffing','verifying',
                      'awaiting_user','completed','failed','cancelled')),
  base_snapshot_ref TEXT,              -- git ref/sha captured before the agent ran
  result_snapshot_ref TEXT,            -- sha after the agent ran (commit or stash-style ref)
  interdiff TEXT,                      -- unified diff of base..result (capped size)
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE fix_round_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fix_round_id INTEGER NOT NULL REFERENCES fix_rounds(id),
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  verdict TEXT CHECK (verdict IN ('addressed','partial','not_addressed')),
  verdict_reasoning TEXT,
  user_decision TEXT CHECK (user_decision IN ('resolved','bounced','ignored')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_fix_round_items_comment ON fix_round_items(comment_id);
```

**Comment status extension:** add `'resolved'` to the `comments.status` CHECK
set. Resolved is terminal-ish like `submitted`: excluded from "active user
comments" queries, shown collapsed with a ✓ and a link to the fix round.
Restore-to-active is supported (mirrors `fix-suggestion-restore-after-adoption`).

> Migration note: `comments` status is enforced by CHECK constraint, so this is
> a table rebuild. Follow the SQLite Migration Safety rules in CLAUDE.md
> (idempotent `DROP TABLE IF EXISTS` on the rebuild table, transaction-wrapped,
> pragma toggles in try/finally). Update BOTH test schemas
> (`tests/e2e/global-setup.js`, `tests/integration/routes.test.js`).

### Permission profiles for bridges

Introduce a `permissionProfile: 'chat' | 'fix'` option on
`createSession()`, threaded to each bridge:

- **ClaudeCodeBridge**: `fix` profile appends `Edit,Write` to `--allowedTools`
  (keep `disableAllHooks`; do NOT use `--dangerously-skip-permissions` —
  consistent with the rationale in `plans/claude-code-chat-bridge.md`).
- **CodexBridge**: `fix` profile approves `item/fileChange/requestApproval` and
  `applyPatchApproval` instead of declining.
- **AcpBridge / PiBridge**: ACP already edits; Pi `fix` profile adds write
  tools to `CHAT_TOOLS`.
- Default stays `'chat'` (read-only) everywhere. No behavior change for
  existing chat.

Config: `features.fix_loop` per-repo toggle (default off initially), plus an
optional `fix_provider` override (defaults to the configured chat provider).
No hot-reload concerns — config loads at startup per project convention.

### Workspace safety (the part that must not be sloppy)

**Both modes, before the agent runs:**
snapshot the tree with `git stash create`-style plumbing that does NOT touch
the working tree: `git add -A --intent-to-add`-free approach — concretely:

```
base_snapshot_ref = git stash create "pair-review fix round <id>"   # or
                    git commit-tree of a temp index if stash returns empty
```

Store the ref in `fix_rounds.base_snapshot_ref` and pin it with
`git update-ref refs/pair-review/fix-<roundId>-base <sha>` so gc can't eat it.
This gives a guaranteed **Restore workspace** action:
`git checkout <base> -- .` limited to files the interdiff touched (never a
blind `reset --hard`, which would destroy user work made after dispatch).

**PR mode additionally:** the worktree is on a **detached HEAD** — both pool
(`worktree-pool-lifecycle.js:266,395` `git.checkout([targetSha])`) and non-pool
worktrees check out the PR head SHA directly; there is no local PR branch to
commit to. After the agent finishes, if the worktree is dirty, commit on the
detached HEAD (`pair-review: fix round <id>` with the round's comment list in
the body), record the sha as `result_snapshot_ref`, and pin it with
`git update-ref refs/pair-review/fix-<roundId> <sha>` so it survives both gc
and the pool moving HEAD elsewhere. Getting the fix onto the actual PR is an
explicit user action later (out of scope round one): create a branch at the
ref, or `git push <remote> <sha>:refs/heads/<head_branch>` when the user has
push rights. Rationale for committing at all:

- The non-pool `refreshWorktree` throws on dirty trees
  (`src/git/worktree.js:1168`) — an uncommitted fix blocks the next refresh.
- Pool lifecycle wipes dirty state with `reset --hard` + `clean -fd`
  (`src/git/worktree-pool-lifecycle.js:260,382`) — an uncommitted fix is
  silently destroyed on reuse. A commit survives as a pinned ref even when the
  pool checks out a different sha (coordinate with
  `plans/restore-pool-worktree-commit.md`).

Pushing that commit (or handing it to the user's own agent session) is
explicitly out of scope for round one — the commit is a local artifact the
user can cherry-pick, push, or discard. The UI must say this plainly.

**Local mode:** the agent edits the user's live working tree. That is the
point — in local mode the "PR" under review IS the uncommitted work of the
user's own coding agent, so the fix belongs in the same tree. The snapshot ref
makes it reversible. Staged changes are already treated as reviewed
(`src/local-scope.js`); the fix prompt must instruct the agent not to stage or
commit, and the app must not stage on its behalf.

### Dispatch flow (server)

New module `src/fix/fix-round-runner.js` (DI per the `defaults`/`_deps`
convention), orchestrated through `backgroundQueue` with job key
`fix-round:<roundId>` (per-review dedup prevents concurrent rounds; the
existing per-key dedup in `background-queue.js:62-88` enforces this if we key
by a stable `fix-round` prefix and reject dispatch while one is active):

1. **Collect** the selected comment ids; load bodies plus, for adopted
   comments, the parent AI suggestion's `reasoning` via `parent_id`.
2. **Snapshot** (above). Insert `fix_rounds` + items. Broadcast WS
   `review:fix_round` events (reuse `broadcastReviewEvent`).
3. **Dispatch**: `chatSessionManager.createSession({ reviewId, provider,
   permissionProfile: 'fix', cwd })` and send one structured message built by a
   new `buildFixDispatchPrompt()` in `prompt-builder.js`: per comment —
   file, line range, side, the human's body, the AI reasoning if adopted, and
   hard rules (fix only what the comments describe; no staging/committing; no
   pushing; report per-comment what you did or why you declined).
   The session is a normal chat session — it appears in ChatPanel, the user
   can watch `tool_use` events stream, and can abort. Completion is detected
   via the existing `complete` listener; a watchdog timeout marks the round
   `failed` if the bridge dies silently.
4. **Diff**: compute interdiff `base_snapshot_ref..worktree` (PR mode: also
   make the result commit). Store on the round. If the interdiff is empty,
   skip verification and mark all items `not_addressed` with the agent's final
   text as reasoning.
5. **Verify** (below). Round → `awaiting_user`.
6. **Refresh** the review diff: PR mode re-renders from the worktree state;
   local mode goes through the existing local diff regeneration + the
   head-change plumbing if the agent (despite instructions) committed.
   Queue a `[Diff State Update]` notification for any other live chat session.

### Verification pass

One provider call per round (not per comment — comments in a round usually
touch related code, and one call sees cross-comment effects), using the
existing HTTP review providers (per project guidance: no `runAgentTask`, no
CLI agent providers for summary-shaped jobs). Input: the comment list and the
interdiff; output schema:

```json
{ "items": [ { "comment_id": 12, "verdict": "addressed",
               "reasoning": "Null guard added at src/foo.js:42..." } ] }
```

Parse with the existing `json-extractor` (LLM-repair fallback included).
Verdicts land on `fix_round_items`; nothing auto-resolves — verdicts are
recommendations.

### Resolution UI

- Round summary panel (new component, rendered in the review panel's flow like
  the external-comments segment): interdiff (rendered with the pierre diff
  pipeline in a collapsible), per-comment verdict rows with
  **Resolve** / **Bounce back** / **Ignore**.
- Resolve → comment `status='resolved'`, `user_decision='resolved'`;
  collapsed ✓ rendering with "fixed in round N" link.
- Bounce → comment stays `active`; the verifier's reasoning is appended to the
  comment thread as context for the next round.
- **Restore workspace** button on the round (destructive-adjacent → confirm
  dialog; restores only files the interdiff touched, from
  `base_snapshot_ref`).
- Entry points: a **Fix these (N)** button in the review submit/panel area
  enabled when active user comments exist, and a per-comment **Fix this** in
  the existing action bar (extends the `actionContext` plumbing from
  `plans/add-chat-buttons-multiple-locations.md`).

### API surface (both modes — parity is mandatory)

| Endpoint | PR mode (`src/routes/reviews.js`/new `src/routes/fix.js`) | Local mode (`src/routes/local.js`) |
|---|---|---|
| Start round | `POST /api/reviews/:reviewId/fix-rounds` | same route — fix rounds key off `reviewId`, which both modes share |
| Round status | `GET /api/reviews/:reviewId/fix-rounds/:id` (poll fallback; WS is primary) | shared |
| Decide item | `POST .../fix-rounds/:id/items/:itemId/decision` | shared |
| Restore | `POST .../fix-rounds/:id/restore` | shared |
| Cancel | `DELETE .../fix-rounds/:id` (aborts session + background job) | shared |

Because rounds hang off `review_id` and cwd resolution already branches by
review type inside `resolveReviewCwd`, one route file can serve both modes —
but the runner has mode-specific branches (commit-in-worktree vs never-commit)
that need explicit tests for each mode.

---

## Phasing

**Phase 1 — Edit-capable sessions (small, independently shippable).**
`permissionProfile` option through `createSession` and all four bridges;
config gate; unit tests per bridge (arg construction, approval handlers).
No UI change. This also fixes the current inconsistency where ACP agents can
already edit but Claude Code/Codex cannot.

**Phase 2 — Data model + dispatch runner.**
Migration (fix tables + `resolved` status), `fix-round-runner.js`, prompt
builder, background-queue integration, WS events, snapshot/commit logic,
API endpoints. Integration tests: full round against a mock bridge in a temp
git repo (mkdtemp per file), both modes, dirty-tree edge cases, empty
interdiff, agent-committed-anyway recovery.

**Phase 3 — Verification pass.**
Prompt template in `src/ai/prompts/`, provider call, verdict persistence.
If prompt templates in `src/ai/prompts/` are shared with skill references,
run `node scripts/generate-skill-prompts.js`.

**Phase 4 — UI.**
Round panel component, verdict rows, resolve/bounce/restore, Fix buttons,
resolved-comment rendering, ChatPanel streaming of the fix session.
E2E tests (headless, `PAIR_REVIEW_NO_OPEN=1`) for both modes.

**Phase 5 — Hardening + docs.**
README section, changeset (`minor`), pool-reuse survival test for the result
commit, multi-round bounce cycle test, MCP: expose fix-round state via a new
`get_fix_rounds` tool so external agents can see resolution outcomes.

Each phase leaves main shippable; the feature flag stays off until Phase 4.

---

## Hazards

- **`resolveReviewCwd` gains a second class of caller.** Today only chat
  routes call it (`src/routes/chat.js:60-76`). The fix runner must reuse it,
  not reimplement it — and if it moves to a shared module, both callers must
  be re-verified (local path vs worktree path resolution).
- **Chat session concurrency.** A fix session and a user-opened chat session
  can run simultaneously against the same cwd. The bridges' `isBusy()` guards
  one session's own turns, not cross-session file conflicts. Mitigate: while a
  round is in `fixing`, surface a banner in ChatPanel and block starting a
  second round (background-queue dedup key gives this for free); do not block
  read-only chat.
- **Stale-check auto-refresh races the fix round.** `_checkStalenessOnLoad`
  (`public/js/pr.js:8152`) silently calls `refreshPR()` when there's no
  protectable work — and `refreshWorktree` may run `git checkout`/reset under
  the agent mid-edit. An active fix round MUST count as protectable session
  work in `_hasActiveSessionData` (`pr.js:8214`), and the server-side refresh
  path must refuse (409) while a round is in `fixing`/`diffing`.
- **Pool worktree wipe.** `_switchPoolWorktree` and pool `refreshWorktree`
  run `reset --hard` + `clean -fd` (`worktree-pool-lifecycle.js:260,382`).
  Uncommitted fix output is destroyed on reuse; even the result commit is
  abandoned when HEAD moves unless pinned. Pin `refs/pair-review/*` refs and
  verify pool cleanup leaves them; align with
  `plans/restore-pool-worktree-commit.md`.
- **`adoptSuggestion` / `updateSuggestionStatus` are multi-caller**
  (`routes/reviews.js:701` adopt, `:769` adopt-edited, restore path). Adding
  `resolved` must not break the restore transition that clears
  `adopted_as_id` (`database.js:3519-3527`), and every query that enumerates
  statuses (`getUserComments`, MCP `get_user_comments`/`get_ai_suggestions`
  default filters, submit-review collection, panel counts) must decide
  explicitly whether `resolved` is included. Grep for `'active'` status
  literals before the migration; list every site in the implementation PR.
- **Comment anchors go stale after the fix.** There is no cross-diff
  re-anchoring; comments re-render by stored `file`+`line_start` against the
  rebuilt DOM (`pr.js:1044`). The agent's fix will often move or delete the
  very lines the comment anchors to — a resolved comment may have no DOM
  anchor after refresh. Resolved comments must render in a file-level or
  round-panel fallback zone rather than silently disappearing (same failure
  mode the external-comments `is_outdated` handling solves; reuse that
  pattern).
- **Async completion handlers assume one thing in flight.**
  `_wireBridgeEvents`' `complete` handler persists assistant messages
  (`session-manager.js:617-642`); the fix runner adds a second `complete`
  consumer. The runner must key on ITS sessionId and tolerate the session
  being closed/aborted by the user from ChatPanel between dispatch and
  completion ("what state could have changed between scheduling and
  execution": user aborted session, user refreshed PR, user edited files
  manually, round cancelled). Every runner step must re-check round status
  before writing.
- **Local mode: agent commits despite instructions.** HEAD moves →
  `branchAvailable` recompute needed (`plans/fix-branch-available-after-head-change.md`)
  and the local diff basis changes. The runner must detect a HEAD change after
  the session and route through the existing `resolve-head-change` logic
  instead of assuming an unstaged delta.
- **Duplicated flows risk.** The runner's "refresh diff after change" must NOT
  become a third refresh implementation — reuse the existing PR refresh and
  local resolve-head-change endpoints/functions. Flag any divergence during
  implementation.
- **ESM check** for any new dependency (none anticipated; interdiff uses git
  plumbing, no new packages).

## Explicit non-goals (round one)

- Auto-push or auto-commit to the user's branch in local mode.
- Auto-resolve without user confirmation.
- Multi-agent fix fan-out (one session per round).
- Fixing external (GitHub) reviewers' comments — dispatch is scoped to this
  tool's user comments; external comments can be adopted first if desired.

## Open questions for the reviewer of this plan

1. Should **Fix this** (single comment) create a full round, or a lightweight
   inline variant? (Plan assumes: same machinery, round of size 1.)
2. ~~PR mode result commit: PR branch vs side branch?~~ Resolved: PR
   worktrees are always detached HEAD, so there is no branch decision —
   commit detached, pin `refs/pair-review/fix-<n>`. Remaining sub-question:
   should the UI offer a one-click "create branch from fix" / "push to PR
   branch" action in round one, or is the pinned ref + instructions enough?
   (Plan assumes: pinned ref only; push actions deferred.)
3. Default `fix_provider`: inherit chat provider, or require explicit opt-in
   per repo the first time? (Plan assumes: inherit, gated by `features.fix_loop`.)
