---
"@in-the-loop-labs/pair-review": patch
---

Fix diff parsing for users with `diff.noprefix=true` git config

Added `--src-prefix=a/ --dst-prefix=b/` flags to all git diff commands that produce unified diff output. This ensures consistent `a/` and `b/` prefixes regardless of user's git configuration settings like `diff.noprefix` or custom `diff.srcPrefix`/`diff.dstPrefix`.
