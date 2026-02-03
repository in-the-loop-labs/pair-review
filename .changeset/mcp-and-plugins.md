---
"@in-the-loop-labs/pair-review": minor
---

Add MCP server and Claude Code plugins for AI coding agent integration

- Expose MCP server via `--mcp` stdio transport and `/mcp` HTTP endpoint with tools for reading review comments, AI suggestions, analysis runs, and prompts, plus triggering new analyses
- Ship two Claude Code plugins: `code-critic` (standalone three-level analysis and critic-loop skills) and `pair-review` (app-integrated review, feedback, and analysis skills)
- Add setup UI with SSE progress streaming for PR and local review initialization
- Add external analysis results import endpoint so standalone analysis can push results into the web UI
- Change default port from 3000 to 7247 to avoid conflicts with common dev servers
