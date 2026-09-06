---
"@in-the-loop-labs/pair-review": patch
---

Refresh the built-in Codex model list for the GPT-6 launch.

- Add GPT-6 Astra as `gpt-6-astra-high` and `gpt-6-astra-xhigh` (thorough tier). Astra is OpenAI's new flagship but costs several times more than Sol, so `gpt-5.6-sol-high` remains the default.
- Remove the retired `gpt-5.4-high`, `gpt-5.4-xhigh`, `gpt-5.4-nano`, and `gpt-5.3-codex` entries (OpenAI retired these models on Aug 31 2026; Codex now rejects them with a 400). They are intentionally not aliased onto other models, so saved councils that reference them fail with an explicit unknown-model error instead of silently running a different model. The legacy `gpt-5.4` alias is gone with them.
- Move `gpt-5.4-mini` to the fast tier — it is now the model used for lightweight extraction steps.
