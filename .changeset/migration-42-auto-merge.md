---
"@in-the-loop-labs/pair-review": patch
---

Auto-merge case-duplicate repo_settings rows during migration instead of blocking startup. Keeps the most recently updated row and writes a backup of removed rows to ~/.pair-review/.
