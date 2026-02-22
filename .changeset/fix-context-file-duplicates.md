---
"@in-the-loop-labs/pair-review": patch
---

Fix duplicate context file entries in sidebar nav and diff panel when the same file has multiple context ranges. Sidebar now deduplicates by path and yields to diff files; diff panel merges ranges into a single wrapper with per-chunk dismiss buttons.
