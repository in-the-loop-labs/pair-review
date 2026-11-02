---
"@in-the-loop-labs/pair-review": patch
---

Speed up file content loading on large PRs: the file-content endpoints now cache each PR's per-file diff blob info instead of re-parsing the whole stored diff on every request
