---
"@in-the-loop-labs/pair-review": minor
---

Add Pi task extension and review model guidance skill

- Task extension (`.pi/extensions/task/`) provides a generic subagent tool for Pi that spawns isolated `pi` subprocess with full tool access, supporting single and parallel execution with per-task model selection
- Review model guidance skill (`.pi/skills/review-model-guidance/`) teaches Pi when and how to switch models during code review, with model-specific recommendations for different review tasks
