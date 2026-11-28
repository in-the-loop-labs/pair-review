---
"@in-the-loop-labs/pair-review": minor
---

Add Antigravity as a chat provider. The new `antigravity-acp` chat provider runs `agy acp` (requires agy 1.5 or later) and can read files, run commands, and resume conversations like the other ACP chat providers. Its model picker borrows the Antigravity analysis catalog, so the same Gemini models (and any `providers.antigravity.models` you configure) are available in chat. Override the command or arguments under `chat_providers.antigravity-acp`.

