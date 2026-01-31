---
"@in-the-loop-labs/pair-review": minor
---

Add `--mcp` flag for stdio MCP transport mode. When started with `pair-review --mcp`, the process acts as a stdio MCP server for AI coding agents while also launching the Express web server for the human reviewer. This enables tighter integration with AI agents like Claude Code that support stdio MCP servers.
