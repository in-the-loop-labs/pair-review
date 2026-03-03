---
"@in-the-loop-labs/pair-review": patch
---

Add separate `chat_providers` config key for chat provider command overrides, distinct from `providers` which configures AI analysis providers. This prevents confusion when configuring different command overrides for the same provider used in different contexts. Also adds shell mode support for multi-word commands (e.g., "devx claude").
