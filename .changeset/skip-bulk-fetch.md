---
"@in-the-loop-labs/pair-review": patch
---

Add per-repo `skip_bulk_fetch` option that opts out of the unconditional `git fetch <remote> --prune` step during PR refresh. The targeted base-SHA and PR-head ref fetches still run, so diff inputs remain correct. Useful on very large monorepos where bulk fetching all refs/tags can take tens of minutes.
