---
"@in-the-loop-labs/pair-review": minor
---

Add Graphite stack-aware base branch selector. When reviewing a stacked PR (or local branch) in a Graphite-managed repository, a dropdown in the toolbar lets you change the diff base to any ancestor in the stack. This replaces the previous 3-call Graphite detection with a single efficient `gt state` call and reads PR numbers from Graphite's local cache.
