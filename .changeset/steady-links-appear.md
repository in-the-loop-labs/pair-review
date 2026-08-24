---
"@in-the-loop-labs/pair-review": patch
---

Show configured repository action links correctly for alternate-host pull requests and recent reviews.

Dashboard rows now resolve their host, links, and navigation target from one server-side rule, so a row's action icon and its click always open the same system. Recent-review rows reconcile a legacy `NULL` host against the PR's recorded URL, so alternate-host reviews recorded before host stamping no longer show a GitHub-labelled link.

A monorepo-style `url_pattern` claimed every `owner/repo` it could match, so a pull request that lives on github.com could be bound to — and linked to — an alternate host that has no github.com presence. Host resolution is now applied consistently across dashboard rows, PR setup, the review page, the review header links, comment sync, and stack analysis, matching the rule the URL parser already enforced. The host-filtered configuration key selects the repository's credentials together with its local path, checkout script, worktree pool, and reset script, so an exclusive alternate-host entry's local configuration is never applied to a github.com pull request.

Also fixes an attribute-escaping hole in the dashboard tables: a pull request title containing a double quote could inject markup into the surrounding `title`/`data-*` attributes.
