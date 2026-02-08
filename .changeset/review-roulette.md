---
"@in-the-loop-labs/pair-review": minor
---

Add Review Roulette mode for Pi provider

- New 'review-roulette' analysis mode dispatches reviews to 3 randomly-selected reasoning models in parallel for diverse perspectives
- Skill instructs Pi to discover available thinking-capable models, pick 3 from different providers, forward the full review prompt, and merge all suggestions with model-attributed summaries
- PI_TASK_MAX_DEPTH set to 2 for roulette mode so review subtasks can use their own subtasks for large PRs
- Env merge ordering fixed: PI_TASK_MAX_DEPTH is an overridable default, PI_CMD always wins from the resolved command
