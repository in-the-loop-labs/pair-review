---
"@in-the-loop-labs/pair-review": minor
---

Add stack review support for analyzing full PR stacks

- Detect PR stacks via GitHub GraphQL branch-chain walking (works for any reviewer, not just the PR author)
- Stack navigation dropdown in the PR header to browse between stacked PRs
- "Analyze Stack" option to run AI analysis across all PRs in a stack sequentially
- Stack progress modal with per-PR status tracking and background mode
- Stack analysis dialog for selecting which PRs to include in the analysis
- Stack-info endpoint returns enriched stack data with analysis status and worktree ownership
