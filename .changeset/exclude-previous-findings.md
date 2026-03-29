---
"@in-the-loop-labs/pair-review": minor
---

Add exclude-previous-findings feature for AI analysis. When enabled, the AI reviewer is instructed to skip issues already identified in GitHub PR review comments or existing pair-review feedback, reducing duplicate suggestions across iterative analysis runs. Includes configurable checkboxes in the analysis config modal, dedup instructions injected into orchestration and consolidation prompts, and an excludeRunId parameter to prevent self-deduplication during council analysis.
