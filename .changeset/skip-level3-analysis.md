---
"@in-the-loop-labs/pair-review": minor
---

Add option to skip Level 3 codebase-wide analysis

- Added "Analysis Scope" section to the AI Analysis config modal with a checkbox to skip Level 3 analysis
- Fast-tier models automatically have Level 3 skipped with an informational banner explaining why
- Switching between model tiers automatically updates the checkbox state to match
- Backend properly handles skipped Level 3 by passing empty results to orchestration
- Reduces analysis time for simple PRs or when using faster models
