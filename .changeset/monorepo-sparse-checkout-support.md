---
"@in-the-loop-labs/pair-review": minor
---

Add monorepo sparse-checkout support

- New `monorepos` config option to specify explicit paths for large monorepos with `~` expansion
- Monorepo paths take highest priority (Tier -1) in repository discovery
- Auto-detect and expand sparse-checkout to include all PR directories
- Inject sparse-checkout guidance into Level 3 analysis prompts so AI agents know they can run `git sparse-checkout add` to explore related code
