---
"@in-the-loop-labs/pair-review": minor
---

Add MCP server for AI coding agent integration

- Expose `/mcp` HTTP endpoint and `--mcp` stdio transport with four read-only tools:
  - `get_server_info` — discover the running server URL (stdio only)
  - `get_user_comments` — fetch human-curated review comments (authored or adopted from AI suggestions)
  - `get_ai_analysis_runs` — list all AI analysis runs for a review
  - `get_ai_suggestions` — fetch AI-generated suggestions, with optional `runId` to target a specific analysis run
- Enable AI coding agents (Claude Code, Cursor, etc.) to programmatically read review feedback via the Model Context Protocol
- Support a critic loop workflow where AI suggestions feed directly back to the coding agent
- Change default port from 3000 to 7247 to avoid conflicts with common dev servers
- Include plugin directory skeleton for future Claude Code plugin distribution
