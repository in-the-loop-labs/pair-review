---
"@in-the-loop-labs/pair-review": patch
---

Fix local mode session identity to include branch name. Previously, sessions were keyed by (path, HEAD SHA) only, so switching branches at the same commit would reuse the wrong session. Sessions are now keyed by (path, HEAD SHA, branch) and branch-scope sessions also match on branch name.
