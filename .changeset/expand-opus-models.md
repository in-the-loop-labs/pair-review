---
"@in-the-loop-labs/pair-review": patch
---

Expand Claude Opus model definitions with granular variants and make Opus the default model

- Replace single `opus` model with five variants: `opus-4.5`, `opus-4.6-low`, `opus-4.6-medium`, `opus` (high effort, default), and `opus-4.6-1m` (1M context)
- Add `cli_model` field to decouple app-level model ID from CLI `--model` argument
- Add `env` and `extra_args` support with three-way merge (built-in → provider config → per-model config)
- Add alias support (`opus-4.6-high` resolves to `opus`)
- Extract `_resolveModelConfig()` to consolidate model lookup logic
- Extract `_quoteShellArgs()` for shell-safe argument quoting with POSIX escaping
- Update default model from `sonnet` to `opus` across all code paths
- Remove hardcoded fallback model list from repo-settings frontend
