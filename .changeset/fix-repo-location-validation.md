---
"@in-the-loop-labs/pair-review": patch
---

Fix repository location validation when reviewing PRs from different repositories

Previously, when running `pair-review <PR-URL>` from a directory containing a different repository, the current working directory was incorrectly registered as the repository location. This caused git operations to fail with errors like "couldn't find remote ref" because the wrong repository was being used.

Now the current directory is validated against the target PR's owner/repo before use. If there's a mismatch, pair-review falls back to finding an existing checkout or cloning the repository to `~/.pair-review/repos/`.
