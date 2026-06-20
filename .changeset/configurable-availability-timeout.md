---
"@in-the-loop-labs/pair-review": minor
---

Make the provider availability-check timeout configurable. The probe run at startup (and on availability refresh) was fixed at 10 seconds, which was too short for providers whose check runs a slow build/compile step. Set `availability_timeout_seconds` on an AI analysis provider (`providers.<id>`, including executable and aliased providers) or a chat provider (`chat_providers.<id>`) to raise it. Unset or invalid values fall back to the existing 10-second default. The Gemini, Copilot, and OpenCode availability probes now terminate a hung `--version` check on expiry instead of leaking the child process.

Also fixes chat-provider availability detection for Pi: a custom `type: "pi"` chat provider (or the built-in Pi overridden with a different `command`) now runs its own `<command> --version` probe — honoring `availability_timeout_seconds` — instead of incorrectly reporting the AI provider's cached Pi status for a different binary.
