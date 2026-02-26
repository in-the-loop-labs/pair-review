---
"@in-the-loop-labs/pair-review": minor
---

Add `checkout_script` option for monorepo sparse-checkout configuration. When configured under `monorepos.<owner/repo>.checkout_script`, the specified script is executed in the new worktree with environment variables (BASE_BRANCH, HEAD_BRANCH, BASE_SHA, HEAD_SHA, PR_NUMBER, WORKTREE_PATH) instead of the built-in sparse-checkout expansion algorithm.
