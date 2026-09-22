---
"@in-the-loop-labs/pair-review": patch
---

Fix remote resolution dropping partial-clone remotes. `git remote -v` appends a filter annotation (e.g. `(fetch) [blob:none]`) for partial clones, which the parser's regex rejected. The matching remote was then ignored and PR-ref fetches fell back to an unrelated remote — including mirrors that don't serve `refs/pull/*`, causing `couldn't find remote ref refs/pull/<n>/head`.
