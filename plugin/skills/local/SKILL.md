---
name: local
description: >
  Open local uncommitted changes for review in the pair-review web UI.
  Use when the user says "review my local changes", "review local", "open local review",
  or wants to start a pair-review session for uncommitted work in the current directory.
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
