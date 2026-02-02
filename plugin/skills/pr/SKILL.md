---
name: pr
description: >
  Open the GitHub pull request for the current branch in the pair-review web UI.
  This only opens the browser — it does not run AI analysis or generate suggestions.
  Once open, the user can browse the diff, leave comments, and trigger analysis
  from the web UI themselves.
  Use when the user says "review this PR", "review pull request", "open PR review",
  or wants to open a pair-review session for the current branch's pull request.
  If the user wants automated AI analysis of the PR rather than just opening the browser,
  use the `agent-analyze` skill (standalone) or `analyze` skill (requires MCP server) instead. Note that the user can also trigger
  AI analysis from within the pair-review web UI after opening it.
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
