---
"@in-the-loop-labs/pair-review": minor
---

Add OpenCode as AI provider with configurable models system

- Add OpenCode provider for flexible model configuration via CLI
- Introduce `providers` config section for customizing any provider's models, command, extra_args, and env
- Rename config keys: `provider` → `default_provider`, `model` → `default_model` (with auto-migration)
- Add `config.example.json` reference file copied to user's config directory on first run
- Support model tiers: fast, balanced, thorough (with free/premium as aliases)
