---
"@in-the-loop-labs/pair-review": minor
---

The default Claude analysis model is now the explicit `opus-4.8-xhigh` (Opus 4.8 at xhigh effort), with `opus` retained as a convenience alias; Opus 4.7 xhigh remains available as the standalone `opus-4.7-xhigh` model id. The Fable model's canonical id is likewise now `fable-5-xhigh`, with `fable` retained as a convenience alias.

Provider config selectors (`default_model`, `disabled_models`, and `models` overrides) now match a model by its canonical id OR any of its aliases, so legacy config values naming `opus` or `fable` keep working — a `default_model` or `models` override resolves to the canonical model, and a `disabled_models` entry naming an alias hides the canonical model. Alias-keyed selectors are canonicalized to the built-in id at config-load time, so an alias-keyed `models` override now actually applies at runtime (its `cli_model`/`env`/`extra_args` are no longer silently dropped when the CLI command is built), and an alias-named `default_model` reaches the frontend as the canonical id its model picker can select. This also fixes a latent bug where the bulk-analysis-config server-side guard matched models by id only, silently coercing a valid model alias (e.g. `opus`) to the provider default; aliases are now recognized and preserved.
