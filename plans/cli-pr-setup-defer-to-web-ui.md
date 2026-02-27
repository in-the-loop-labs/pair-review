# Plan: Defer PR Setup to Web UI Setup Page

## Context

When a user runs `npx pair-review 123`, the CLI currently performs the entire setup workflow in the terminal (~10 steps including GitHub API calls, worktree creation, diff generation) before opening the browser. The user stares at terminal output for 10-30 seconds.

The web UI already has a polished setup page (`setup.html`) with step-by-step progress indicators, SSE streaming, error handling, and retry — but it's only used when navigating to a PR from the web UI's home page, not from the CLI.

This change makes the CLI open the browser immediately to the setup page, giving the user a faster, visual setup experience instead of terminal output.

## Changes

### `src/main.js` — Simplify `handlePullRequest()` (lines 468-631)

**Keep:**
- GitHub token check (quick fail before opening browser)
- PR argument parsing (`PRArgumentParser`)
- Register cwd as known repo path if it matches target repo (preserves Tier 0 discovery optimization for `setupPRReview()`)
- `PAIR_REVIEW_MODEL` env var if `--model` flag present

**Remove:**
- All GitHub API calls (`repositoryExists()`, `fetchPullRequest()`)
- Repository discovery logic (`findRepositoryPath()`, monorepo options)
- Worktree creation (`GitWorktreeManager.createWorktreeForPR()`)
- Diff generation (`generateUnifiedDiff()`, `getChangedFiles()`)
- DB storage (`storePRData()`)
- HTTP POST retry loop for `--ai` auto-analysis trigger

**Change:**
- Call `startServer(db)` directly instead of `startServerWithPRContext()`
- Call `cleanupStaleWorktreesAsync(config)` directly
- Open browser to `/pr/owner/repo/number` (append `?analyze=true` if `--ai`)
- Simplify error handling (most errors now surface in setup page)

### `src/main.js` — Delete `startServerWithPRContext()` (lines 657-679)

This function sets three env vars: `PAIR_REVIEW_PR` (never read — dead code), `PAIR_REVIEW_AUTO_AI` (never read — dead code), and `PAIR_REVIEW_MODEL` (moved to `handlePullRequest()`). The rest is just `startServer(db)` + `cleanupStaleWorktreesAsync()`.

### No changes needed to:
- `src/routes/setup.js` — POST/SSE endpoints already handle the full setup flow
- `src/setup/pr-setup.js` — `setupPRReview()` already does the work
- `public/setup.html` — Already forwards `?analyze=true` on redirect (lines 759, 827)
- `src/server.js` — Route already serves `setup.html` when no PR data exists (line 212-213)
- `public/js/pr.js` — Already handles `?analyze=true` (line 377)
- `performHeadlessReview()` — Headless modes (`--ai-draft`, `--ai-review`) unchanged

### Changeset

Create a changeset for this minor feature (better startup UX).

## Verification

1. `npm test` — existing tests pass (no tests exist for `handlePullRequest` or `startServerWithPRContext`)
2. `npm run test:e2e` — E2E tests pass (includes auto-analyze flow)
3. Manual: `npx pair-review <PR-URL>` — browser opens immediately to setup page, shows progress, redirects to review
4. Manual: `npx pair-review <PR-URL> --ai` — same as above, auto-analysis triggers after setup
5. Manual: `npx pair-review <PR-URL> --ai-draft` — headless mode unchanged
6. Manual: missing token — terminal error before browser opens
