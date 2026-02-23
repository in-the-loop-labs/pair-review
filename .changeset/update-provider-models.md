---
"@in-the-loop-labs/pair-review": patch
---

Update built-in model definitions for Gemini, Copilot, and Cursor Agent providers

- Gemini: Drop `-preview` suffix from gemini-3-flash and gemini-3-pro (with aliases for backward compat), add gemini-3.1-pro
- Copilot: Add claude-sonnet-4.6 (new default), gpt-5.3-codex, claude-opus-4.6-fast; demote sonnet-4.5
- Cursor Agent: Add sonnet-4.6-thinking (new default), gemini-3.1-pro, gpt-5.3-codex-xhigh; demote sonnet-4.5-thinking
- Extract default model constants to reduce duplication across constructor and getDefaultModel()
