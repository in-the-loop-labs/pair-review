---
"@in-the-loop-labs/pair-review": patch
---

Fix context files disappearing from the diff panel on review reload by clearing stale in-memory state in `renderDiff()` so that `loadContextFiles()` correctly re-renders them
