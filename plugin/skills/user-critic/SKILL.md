---
name: user-critic
description: >
  Fetch human review comments from pair-review and make code changes to address them.
  Use when the user says "address review feedback", "fix review comments", "address comments",
  or wants to iterate on code based on feedback left by a human reviewer in pair-review.
---

# Address Review Feedback

Fetch human-curated review comments from pair-review and make code changes to address each one.

## Determine review context

Determine whether this is a local review or a PR review:

1. If the user explicitly says "local", use local mode.
2. Otherwise, determine the GitHub owner, repo, and PR number for the current branch. If a PR exists, use PR mode with `repo` and `prNumber` params.
3. If no PR exists, use local mode with `path` (absolute cwd) and `headSha` (`git rev-parse HEAD`) params.

## Fetch comments

Call `mcp__pair-review__get_user_comments` with the review context params.

If no comments are returned, tell the user there's nothing to address.

## Address each comment

For each comment returned:

1. Read the file at the referenced path and lines.
2. Understand what the reviewer is asking for — it may be a bug fix, a refactoring request, a question, or a style change.
3. Make the code change that addresses the feedback.
4. If the comment is a question or unclear, explain your interpretation and what you changed.

## Report

After addressing all comments, provide a summary:
- Which files were changed
- What was done for each comment
- Any comments that were ambiguous or could not be addressed (explain why)
