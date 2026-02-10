---
"@in-the-loop-labs/pair-review": patch
---

Fix shell quoting for --allowedTools when using multi-word CLI commands (e.g. `devx claude --`). The regex that detects shell metacharacters used `[]` which JavaScript treats as an empty character class matching nothing, unlike POSIX regex where `]` after `[` is literal. This caused parentheses in tool patterns like `Bash(git diff*)` to be interpreted as shell syntax, producing a syntax error.
