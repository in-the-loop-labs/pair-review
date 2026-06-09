---
"@in-the-loop-labs/pair-review": minor
---

Add a `--provider` CLI flag (and matching `PAIR_REVIEW_PROVIDER` env var) to select the AI provider for headless reviews.

Previously, headless modes (`--ai-draft` / `--ai-review`) only let you set the model via `--model`, while the provider was always taken from repo/app config (defaulting to `claude`). Passing a non-default provider's model (e.g. `--model gpt-5.5`) would run it through the default provider and fail or misbehave. You can now pin both, e.g. `pair-review 123 --ai-draft --provider codex --model gpt-5.5`. The flag mirrors `--model`: it sets `PAIR_REVIEW_PROVIDER`, which the web/UI analysis paths also honor (the MCP path already did).
