---
name: local
description: >
  Open local uncommitted changes for review in the pair-review web UI.
  This only opens the browser — it does not run AI analysis or generate suggestions.
  Once open, the user can browse the diff, leave comments, and trigger analysis
  from the web UI themselves.
  Use when the user says "review my local changes", "review local", "open local review",
  or wants to open a pair-review session for uncommitted work in the current directory.
  If the user wants automated AI analysis of their local changes rather than just opening
  the browser, use the `agent-analyze` skill (standalone) or `analyze` skill (requires MCP server) instead. Note that the user can
  also trigger AI analysis from within the pair-review web UI after opening it.
---

# Local Review

Open the current working directory in the pair-review web UI for local code review.

## Steps

1. Call the `mcp__pair-review__get_server_info` tool to get the server URL.
2. Get the absolute path of the current working directory.
3. URL-encode the path.
4. Open the browser: `open "{url}/local?path={encoded_path}"`

If `get_server_info` fails or the MCP server is not connected, tell the user to start pair-review first:
```
npx @in-the-loop-labs/pair-review --mcp
```
