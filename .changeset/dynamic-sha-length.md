---
"@in-the-loop-labs/pair-review": patch
---

Use Git's dynamic SHA abbreviation length instead of hardcoded 7-char truncation. Calls `git rev-parse --short HEAD` to respect the repository's `core.abbrev` setting and Git's auto-scaling for large monorepos.
