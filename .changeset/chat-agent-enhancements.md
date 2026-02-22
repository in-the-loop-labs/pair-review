---
"@in-the-loop-labs/pair-review": patch
---

Enhance chat agent with task extension and review context guidance

- Load the task extension (`-e .pi/extensions/task`) for chat agent sessions, enabling subagent delegation
- Add review context to the system prompt so the agent knows the correct `git diff` command for the review type (local vs PR)
- Pass the absolute path to the pair-review-api SKILL.md in the system prompt to reduce agent fumbling
- Fix skill file read suppression to check both `path` and `file_path` arg names
