---
"@in-the-loop-labs/pair-review": minor
---

Add MCP Streamable HTTP endpoint for AI coding agent integration

- Expose `/mcp` endpoint on the pair-review server with three read-only tools: `get_review_comments`, `get_ai_suggestions`, `get_review_summary`
- Enable AI coding agents (Claude Code, etc.) to programmatically read review feedback via the Model Context Protocol
- Change default port from 3000 to 7247 to avoid conflicts with common dev servers
- Include plugin directory skeleton for future Claude Code plugin distribution
