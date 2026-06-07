---
"@in-the-loop-labs/pair-review": patch
---

Fix external/inline PR review comment sync so it respects per-repo alt-host bindings instead of always calling `api.github.com`. The sync flow now resolves the review's `repository` to its host binding (`api_host` + repo-scoped `token` / `token_command`) before fetching comments, mirroring the binding-aware credential resolution used elsewhere. Alt-host PRs previously 404'd because the sync targeted `api.github.com` with the top-level github.com token; `github.com` repos are unaffected.
