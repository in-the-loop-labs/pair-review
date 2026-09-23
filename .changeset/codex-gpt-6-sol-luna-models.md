---
"@in-the-loop-labs/pair-review": patch
---

Add GPT-6 Sol and GPT-6 Luna models to the Codex provider and replace the retired `gpt-5.4-mini`

- GPT-6 Sol (`gpt-6-sol-high`, `gpt-6-sol-xhigh`) and GPT-6 Luna (`gpt-6-luna-max`,
  `gpt-6-luna-low`) can now be picked. OpenAI is still rolling out GPT-6 access, and
  Enterprise workspace admins must enable it, so these entries are opt-in.
- The Codex default stays `gpt-5.6-sol-high` so default analyses keep working for
  accounts without GPT-6 access.
- JSON extraction and hunk summaries now run on `gpt-5.6-luna-low` instead of
  `gpt-5.4-mini`. OpenAI retired `gpt-5.4-mini` for ChatGPT sign-in on 2026-08-31,
  and Codex has rejected it with a 400 since then, so extraction failed for ChatGPT
  users.
- `gpt-5.4-mini` is removed with no alias. API-key users can still name it directly
  (`--model gpt-5.4-mini`) or add it under `providers.codex.models`.
- The GPT-5.5 entries remain for now; OpenAI retires GPT-5.5 from Codex on 2026-10-14.
