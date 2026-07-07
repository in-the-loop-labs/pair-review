---
"@in-the-loop-labs/pair-review": major
---

**Breaking:** Remove the `PAIR_REVIEW_PROVIDER` and `PAIR_REVIEW_MODEL` environment variables.

The AI provider and model are now selected exclusively through the `--provider` / `--model` CLI flags, saved repo settings, or the `default_provider` / `default_model` config keys (settable per-repo or globally on the settings pages). Setting `PAIR_REVIEW_PROVIDER` or `PAIR_REVIEW_MODEL` in the environment has no effect.

Previously these env vars doubled as the transport for the `--provider` / `--model` flags; that side channel is gone. The flags are now threaded explicitly from the CLI entry point into the server (`app.get('cliOverrides')`), so per-run intent still outranks repo settings and config defaults, and single-port delegation still carries the override to an already-running server via the auto-analysis URL.

**Migration:**
- Replace `PAIR_REVIEW_PROVIDER=codex pair-review 123 --ai-draft` with `pair-review 123 --ai-draft --provider codex`.
- Replace `PAIR_REVIEW_MODEL=gpt-5.5 …` with `--model gpt-5.5`.
- For a persistent default with no flag, set `default_provider` / `default_model` in `~/.pair-review/config.json`, in per-repo settings, or on the global settings page.
