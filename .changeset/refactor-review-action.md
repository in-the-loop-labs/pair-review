---
"@in-the-loop-labs/pair-review": minor
---

Consolidate headless review modes and fix GitHub Actions compatibility

- Extract shared logic from `--ai-draft` and `--ai-review` into `performHeadlessReview()`, eliminating ~275 lines of duplication
- Switch `--ai-review` from REST to GraphQL submission, matching the web UI pipeline
- Apply draft-mode patterns throughout: normalizeRepository, COLLATE NOCASE, repoInstructions, updateAfterSubmission
- Fix `--use-checkout` storing user's working directory as a managed worktree, breaking subsequent normal runs
- Show AI suggestions with 'submitted' status in the web UI after headless review
- Drop `validateToken()` GET /user call that caused "Resource not accessible by integration" in GitHub Actions
- Remove `--fail-on-issues` flag
- Add `--use-checkout` warning when used without `--ai-draft` or `--ai-review`
- Export `detectPRFromGitHubEnvironment()` with unit tests
