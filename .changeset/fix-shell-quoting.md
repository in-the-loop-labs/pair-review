---
"@in-the-loop-labs/pair-review": patch
---

Fix shell quoting across all AI providers when using multi-word CLI commands (e.g. `devx claude --`). The original regex in Claude's `_quoteShellArgs()` used `[]` which JavaScript treats as an empty character class matching nothing, so arguments with shell metacharacters like `Bash(git diff*)` were never quoted. Extracted a shared `quoteShellArgs()` utility into the base provider module and applied it to all 7 providers: Claude, Gemini, Copilot, Codex, Pi, OpenCode, and Cursor Agent.
