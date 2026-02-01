---
name: pr
description: >
  Open the GitHub pull request for the current branch in the pair-review web UI.
  Use when the user says "review this PR", "review pull request", "open PR review",
  or wants to start a pair-review session for the current branch's pull request.
---

# PR Review

Open the current branch's GitHub PR in the pair-review web UI.

## Steps

1. Call the `mcp__pair-review__get_server_info` tool to get the server URL.
2. Determine the GitHub owner, repo, and PR number for the current branch.
3. Open the browser: `open "{url}/pr/{owner}/{repo}/{number}"`

## Error handling

- If `get_server_info` fails, tell the user to start pair-review first: `npx @in-the-loop-labs/pair-review --mcp`
- If no PR exists for the current branch, tell the user.
