---
"@in-the-loop-labs/pair-review": patch
---

Add GPT-6.1 Terra XHigh as an explicit balanced choice in the Codex provider, and remove GPT-5.5 High and XHigh, which Codex retired for ChatGPT sign-in on 2026-10-14. Saved configs that name `gpt-5.5-high` or `gpt-5.5-xhigh` now fail with Codex's unknown-model error instead of silently running another model; API-key users can still name `gpt-5.5` directly. GPT-5.6 Sol High stays the recommended default while GPT-6.1 access rolls out.
