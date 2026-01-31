---
"@in-the-loop-labs/pair-review": minor
---

Add GitHub Action review mode for CI-based code reviews

- New `--ai-review` flag that runs AI analysis and submits a published review (COMMENT event) to GitHub, designed for CI pipelines
- Auto-detect PR number, owner, and repo from GitHub Actions environment variables (`GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_EVENT_PATH`)
- New `--use-checkout` flag to skip worktree creation and use the current working directory (automatic in GitHub Actions)
- Support `PAIR_REVIEW_MAX_BUDGET_USD` environment variable to cap Claude API spend per review
- Include a ready-to-use GitHub Actions workflow (`.github/workflows/ai-review.yml`)
- Drop the `validateToken()` pre-flight call that failed with `GITHUB_TOKEN` in Actions ("Resource not accessible by integration")
- Show AI suggestions with `submitted` status in the web UI after headless review
