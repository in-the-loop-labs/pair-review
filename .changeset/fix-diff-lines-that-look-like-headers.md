---
"@in-the-loop-labs/pair-review": patch
---

Fix diffs with removed lines starting with `--` or added lines starting with `++` (such as SQL or Lua comments)

- These lines no longer shift the line numbers after them. Comments on the file are submitted to GitHub as inline comments on the right line, and the annotated diff the AI reads has the right line numbers.
- Added and deleted line counts now include these lines.
