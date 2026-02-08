---
"@in-the-loop-labs/pair-review": minor
---

Integrate Pi task extension into pi-provider

- Pi provider now loads the task extension via `-e`, giving the model a subagent tool for delegating work to isolated subprocesses during analysis
- Task extension propagates parent's active tool list to subtasks, preserving read-only security restrictions
- PI_CMD environment variable propagated to subtasks for wrapper compatibility (e.g., `devx pi --`)
- Auto-discovery disabled (`--no-extensions`, `--no-skills`, `--no-prompt-templates`) for deterministic runs
- Full CLI command logged at debug level on every pi spawn
