---
name: ai-critic
description: >
  Fetch AI-generated review suggestions from pair-review and make code changes to address them.
  Use when the user says "address AI feedback", "address AI suggestions", "fix AI review feedback",
  or wants to iterate on code based on AI analysis results from pair-review.
---

# AI Critic

Fetch AI-generated suggestions from pair-review and make code changes to address the valid ones.

## Determine review context

Determine whether this is a local review or a PR review:

1. If the user explicitly says "local", use local mode.
2. Otherwise, determine the GitHub owner, repo, and PR number for the current branch. If a PR exists, use PR mode with `repo` and `prNumber` params.
3. If no PR exists, use local mode with `path` (absolute cwd) and `headSha` (`git rev-parse HEAD`) params.

## Fetch AI suggestions

Call `mcp__pair-review__get_ai_suggestions` with the review context params. This returns suggestions from the latest analysis run by default.

If the user wants suggestions from a specific analysis run, call `mcp__pair-review__get_ai_analysis_runs` first to list available runs, then pass the appropriate `runId` to `get_ai_suggestions`.

Only active and adopted suggestions are included (dismissed ones are excluded).

If no suggestions are returned, tell the user there are no AI suggestions to address.

## Triage and address suggestions

AI suggestions are not human-curated — apply judgment. For each suggestion:

1. Read the file at the referenced path and lines.
2. Evaluate the suggestion: is it a real issue, a false positive, or a stylistic preference?
3. If the suggestion is valid and actionable, make the code change.
4. If the suggestion is a false positive or not worth addressing, skip it and note why.

Use the `ai_confidence` field as a signal but not a hard threshold — low-confidence suggestions can still be valid.

## Report

After processing all suggestions, provide a summary:
- How many suggestions were reviewed
- Which ones were addressed (and what changed)
- Which ones were skipped (and why)
