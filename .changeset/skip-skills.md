---
"@in-the-loop-labs/pair-review": minor
---

Add per-repository and per-provider `load_skills` configuration to control whether AI providers load skill extensions during analysis. Resolution follows a 4-tier cascade: DB repo settings > repo JSON config > provider-level config > default (enabled). Council mode resolves overrides per-voice so mixed-provider councils respect provider-specific settings. Includes a toggle in the repo settings UI.
