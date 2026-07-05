---
"@in-the-loop-labs/pair-review": minor
---

Add the `pair-loop` Claude Code plugin: an agent-orchestrated review loop that
uses pair-review as the review oracle. The `/pair-loop:loop` skill runs
multi-model council reviews through the headless CLI
(`pair-review --headless --json --council <handle>`), triages the findings,
applies fixes, and repeats with narrowing instructions until a final review
returns no blockers. When the pair-review server is running, triage is
written back over HTTP so the web UI reflects the loop's decisions.
MCP-independent; works in local and PR mode.
