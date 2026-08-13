---
"@in-the-loop-labs/pair-review": minor
---

Show associated PR metadata in local reviews. When a local branch has an associated GitHub PR, the header now displays a clickable PR pill with title, author, and state — pulled from the GitHub API and cached in `pr_metadata`. Merged PRs render distinctly from closed ones. The pill is hidden when no PR is associated, and appears as soon as the metadata is fetched on a cold cache rather than waiting for a page reload.

Local-mode GitHub calls for an associated PR now go through the repository's resolved host binding instead of the global token, so Enterprise/alt-host repos and repos with a repo-scoped `token`/`token_command` reach the right host with the right credential. The cached metadata row records the host it was fetched from. A binding for an alt host that carries no credential fails closed rather than falling back to the github.com token, so an Enterprise repo is never queried against api.github.com. For a repo configured on both github.com and an alt host, where the host cannot yet be determined from the local review alone, no metadata is cached at all — the pill stays hidden rather than pinning that PR to a guessed host that later PR-mode setup would read back as fact.

Fixed a PR-mode bug where refreshing a merged PR dropped its `merged` flag from the cached metadata, so the PR was subsequently treated — and now displayed — as merely closed.

Caching a PR's metadata for a local review no longer counts as opening that PR: the cached row is not listed in the dashboard's recent-PR tab and does not link to a PR-mode setup the user never asked for. Fixes a related pagination bug where a row with no recorded access time could be duplicated across pages.
