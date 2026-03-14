---
"@in-the-loop-labs/pair-review": minor
---

Add `github_token_command` config option to resolve GitHub tokens from shell commands. Defaults to `gh auth token` for zero-config token resolution with the GitHub CLI. Also supports 1Password CLI, pass, and custom scripts. Successful results are cached per process; failures retry on next call.
