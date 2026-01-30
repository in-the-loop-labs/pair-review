---
"@in-the-loop-labs/pair-review": minor
---

Add GitHub draft review tracking with `github_reviews` table

- Track GitHub review submissions in a new `github_reviews` table with full lifecycle management (pending, submitted, dismissed)
- Detect existing pending drafts on GitHub and add comments to them instead of creating duplicate reviews
- Sync draft state with GitHub, including drafts created outside pair-review
- Show pending draft indicator in toolbar and context-aware labels in the Submit Review dialog
- Unify CLI `--ai-draft` and web UI to use the same GraphQL API and database tracking
