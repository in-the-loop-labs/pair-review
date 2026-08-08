---
"@in-the-loop-labs/pair-review": minor
---

Add Meta's Muse Code CLI (`muse`) as an AI review-analysis provider. Override the CLI command with `PAIR_REVIEW_MUSE_CMD`. Analysis runs headlessly via `muse exec --json`, so the CLI must be installed and authenticated once with `muse login`.

Select Muse from the repository or global settings pages, which pick a provider and a model together. From the CLI or config file, name a model alongside the provider — `--provider muse --model muse-spark-1.2`, or `default_provider` **and** `default_model` in `~/.pair-review/config.json`. Provider and model resolve on separate ladders, so `--provider muse` on its own leaves the model at the global default (`opus` out of the box) and Muse rejects the pair with ``model `opus` is not in the catalog``. This is long-standing behavior shared by every provider, not something specific to Muse.

The built-in models are reasoning-effort variants over two underlying CLI models: `muse-spark-1.2-ultra` / `muse-spark-1.2-contributor-ultra` and `muse-spark-1.2-xhigh` / `muse-spark-1.2-contributor-xhigh` (thorough), `muse-spark-1.2-high` (balanced, the default, aliased as `muse-spark-1.2` and `muse-spark`), `muse-spark-1.2-contributor-high` (balanced, aliased as `muse-spark-1.2-contributor`), and `muse-spark-1.2-low` / `muse-spark-1.2-contributor-low` (fast). The `-contributor` models are cheaper because Meta may use their content for product improvement, so the default deliberately stays on the non-contributor model — opting into data sharing is an explicit choice, and naming the bare CLI model `muse-spark-1.2-contributor` makes that choice too.
