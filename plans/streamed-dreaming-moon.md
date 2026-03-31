# Scope-Aware Chat Hints for Local Reviews

## Context

The chat agent's "Viewing Code Changes" system prompt is hardcoded for the default unstaged+untracked scope, telling the agent to use `git diff --no-ext-diff`. When the user changes the diff scope (e.g., to Branch–Untracked or Staged), the agent doesn't know the correct git commands and gives wrong answers about what's under review.

The review record already stores `local_scope_start`, `local_scope_end`, and `local_base_branch` — these just need to flow into the chat prompt.

## Plan

### Step 1: Add `scopeGitHints()` to `src/local-scope.js`

New function mapping scope range → git command guidance. Returns `{ label, description, diffCommand, excludes, includesUntracked }`.

- Must stay isomorphic (runs in browser + Node)
- Accepts optional `baseBranch` param; produces `$(git merge-base <branch> HEAD)` when provided, `<merge-base>` placeholder when not
- Covers all 10 valid scope combinations
- Export it on the `LocalScope` object

Key mappings:
| Scope | diffCommand |
|---|---|
| branch | `git diff --no-ext-diff $(git merge-base main HEAD)..HEAD` |
| branch–staged | `git diff --no-ext-diff --cached $(git merge-base main HEAD)` |
| branch–unstaged/untracked | `git diff --no-ext-diff $(git merge-base main HEAD)` |
| staged | `git diff --no-ext-diff --cached` |
| staged–unstaged/untracked | `git diff --no-ext-diff HEAD` |
| unstaged/unstaged–untracked | `git diff --no-ext-diff` |
| untracked | `git ls-files --others --exclude-standard` |

### Step 2: Update `buildReviewContext()` in `src/chat/prompt-builder.js`

- Import `local-scope` (`scopeGitHints`, `DEFAULT_SCOPE`)
- Read `review.local_scope_start`, `local_scope_end`, `local_base_branch`
- Use `scopeGitHints()` to produce the "Viewing Code Changes" section
- Fall back to default scope when fields are missing (backward compat)

### Step 3: Enrich scope-change notifications in `public/js/local.js`

Two call sites to update:

**`_handleScopeChange` (line 1618):** After `_applyScopeResult`, `this.localData?.baseBranch` is populated. Call `LS.scopeGitHints(scopeStart, scopeEnd, this.localData?.baseBranch)` and include description + diffCommand in the notification.

**`showBranchReviewDialog` handler (line 1753):** `branchInfo.baseBranch` is in scope. Call `LS.scopeGitHints('branch', newEnd, branchInfo.baseBranch)` and enrich the notification.

### Step 4: Tests

**`tests/unit/local-scope.test.js`:** New `describe('scopeGitHints')` block — all 10 valid combos, baseBranch substitution, invalid scope returns null, includesUntracked correctness.

**`tests/unit/chat/prompt-builder.test.js`:** Scope-aware local review context tests — branch scope with baseBranch, default fallback when scope fields missing, untracked hint presence/absence.

## Hazards

- `buildReviewContext` is called from 3 places in `src/routes/chat.js` (create, auto-resume, explicit resume). All load the full review record, so scope fields are always available.
- `_applyScopeResult` has two callers: `_handleScopeChange` and `showBranchReviewDialog`. Both notification sites must be updated.
- System prompt is not updated mid-session. The enriched notification text is the only mechanism for mid-session scope changes — this is an accepted constraint.
- `scopeGitHints` must be pure (no Node imports) to stay isomorphic.

## Files to modify

- `src/local-scope.js` — add `scopeGitHints()`, export it
- `src/chat/prompt-builder.js` — import local-scope, update `buildReviewContext` local branch
- `public/js/local.js` — enrich notifications at two call sites
- `tests/unit/local-scope.test.js` — tests for `scopeGitHints`
- `tests/unit/chat/prompt-builder.test.js` — tests for scope-aware prompt

## Verification

1. `npm test` — unit tests pass (especially local-scope and prompt-builder suites)
2. `npm run test:e2e` — E2E tests pass
3. Manual: start a local review, open chat, verify system prompt describes current scope correctly. Change scope via dropdown, send a message, verify the notification includes git command guidance.
