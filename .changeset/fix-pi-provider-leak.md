---
"@in-the-loop-labs/pair-review": patch
---

Fix chat provider ID "pi" being incorrectly passed as --provider to the Pi CLI, which expects a model provider (e.g. "google", "anthropic"). The provider flag is now only set when explicitly configured by the user.
