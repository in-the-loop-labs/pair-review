---
"@in-the-loop-labs/pair-review": patch
---

Store unified diff snapshot on analysis runs for consistent sharing

Analysis runs now capture and store the unified diff at the time of analysis. This ensures that when sharing a review, the diff matches the suggestions even if the branch has been force-pushed or updated since the analysis was performed.

- Added `diff` column to `analysis_runs` table (migration 27)
- Capture diff snapshot in `analyzeAllLevels` and `runReviewerCentricCouncil`
- Share endpoint uses run's `head_sha` and `diff` with fallback to current PR data
- Optimized queries to exclude large diff column by default (`includeDiff` option)
