---
"@in-the-loop-labs/pair-review": minor
---

Add a `--provider` CLI flag (and matching `PAIR_REVIEW_PROVIDER` env var) to select the AI provider for headless reviews.

Previously, headless modes (`--ai-draft` / `--ai-review`) only let you set the model via `--model`, while the provider was always taken from repo/app config (defaulting to `claude`). Passing a non-default provider's model (e.g. `--model gpt-5.5`) would run it through the default provider and fail or misbehave. You can now pin both, e.g. `pair-review 123 --ai-draft --provider codex --model gpt-5.5`. The flag mirrors `--model`: it sets `PAIR_REVIEW_PROVIDER`, which the web/UI analysis paths also honor (the MCP path already did).

The override now also reaches **browser-driven** analyses. `pair-review <target> --ai --provider codex` changes the provider used by auto-analysis (and seeds the manual, stack, and bulk analysis modals) instead of being silently ignored — the browser previously sourced its default from a channel blind to the CLI flag. `/api/config` now surfaces the override as a dedicated signal that the frontend ranks ahead of saved repo settings (`CLI/env > repo settings`), and the override is carried across single-port delegation to an already-running server via the auto-analysis URL. When the repo default is a Review Council, an active `--provider`/`--model` override forces the single-provider path.

The override now travels reliably across the full delegation path. Env-only invocations (`PAIR_REVIEW_PROVIDER=codex pair-review <target> --ai`, no `--provider` flag) are normalized into the effective flags at startup, so they ride the single-port delegation URL just like the flag does. And the auto-analyze intent (`analyze`/`analysisConfigId`/`council`/`provider`/`model`) now travels as one bundle through every browser hop — the setup-page redirects and the "Reload PR" retry — so neither the override nor a CLI `--council` selection is dropped when a review has to be set up or re-set-up before analysis runs.
