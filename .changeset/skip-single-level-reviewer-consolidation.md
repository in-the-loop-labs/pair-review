---
"@in-the-loop-labs/pair-review": patch
---

Skip the per-reviewer consolidation step in multi-reviewer councils when only one analysis level produced results. With a single input there is nothing to merge, so the extra AI call is no longer made. Cross-reviewer consolidation still runs as before.
