---
"@in-the-loop-labs/pair-review": patch
---

Refresh GitHub Copilot built-in models: Claude 5.5 and GPT-5.6

- New built-ins: `claude-haiku-5.5` and `gpt-5.6-luna` (fast), `claude-sonnet-5.5`
  (new default) and `gpt-5.6-terra` (balanced), `claude-opus-5.5` and `gpt-5.6-sol`
  (thorough). JSON extraction and hunk summaries now run on Claude Haiku 5.5.
- Removed retired ids: `claude-sonnet-4.6`, `claude-opus-4.5`, `claude-opus-4.6`,
  `claude-opus-4.6-fast`, `gpt-5.4`, `gpt-5.4-mini`, and `claude-haiku-4.6`.
  `gpt-5.3-codex` is no longer a built-in either. None of these ids is aliased to a
  new model. Copilot still accepts any model id it supports through `--model` or
  `providers.copilot.models`.
- The new ids need a recent Copilot CLI. Run `copilot update` if a model is rejected.
