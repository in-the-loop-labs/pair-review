---
"@in-the-loop-labs/pair-review": minor
---

Show real-time AI activity snippets in the progress modal during analysis

- Display live assistant text and tool usage under each analysis level while running
- Side-channel StreamParser reads provider stdout incrementally without affecting existing output handling
- Support streaming from Claude, Codex, Gemini, and OpenCode providers (Copilot excluded — no JSONL output)
- Smart filtering: prefer assistant text, show tool calls only after 2s gap
- Throttled broadcasts (300ms per level) to avoid UI flicker
- Strip worktree path prefixes from file paths for cleaner display
- Extract meaningful detail from tool calls: commands, file paths (snake_case and camelCase), and Task descriptions
