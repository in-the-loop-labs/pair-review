---
"@in-the-loop-labs/pair-review": patch
---

Fix UI jank in the @pierre/diffs renderer on large PRs. Diff file bodies now render lazily as they approach the viewport (restoring the lazy-render behavior of the legacy renderer), collapsed and viewed files skip rendering entirely until expanded, comments and AI suggestions apply in one batched rerender per file instead of one per annotation, and each file's patch is parsed once instead of twice.
