---
"@in-the-loop-labs/pair-review": patch
---

Fix Codex provider PATH inheritance for git-diff-lines

Configure Codex CLI to disable login shell and whitelist PATH inheritance, ensuring the `git-diff-lines` utility is findable. Previously, Codex's login shell (`zsh -l`) would reconstruct PATH from scratch, losing the BIN_DIR modification that makes `git-diff-lines` available.

Changes:
- Add `-c allow_login_shell=false` to prevent login shell PATH reconstruction
- Add `-c shell_environment_policy.include_only=["PATH", "HOME", "USER"]` to whitelist env var inheritance
- Apply to both `codex exec` (analysis) and `codex app-server` (chat) modes
