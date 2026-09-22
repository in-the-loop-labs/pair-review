---
"@in-the-loop-labs/pair-review": patch
---

Add a per-repo `clone_url` config option

`repos["owner/repo"].clone_url` declares the canonical git clone URL for a
repository. It is primarily for alternate hosts whose GitHub-compatible REST
API omits `base.repo.clone_url` from the pull request response — without it,
pair-review fell back to `https://github.com/<owner>/<repo>.git`, which
matched the wrong local remote when fetching the PR and cloned from github.com
when no local checkout existed.

When set, the configured value wins over the API's `base.repo.clone_url`, is
matched against the local checkout's `git remote -v` entries to pick the fetch
remote, and is the URL used for a fresh clone. Remote resolution now tries the
clone URL against every remote before falling back to matching the PR's
`ssh_url`, so a remote matching the API's SSH URL can no longer outrank the
configured one. Restore mode (reopening a stored review, which never calls the
API) applies the configured URL to the stored snapshot before setup, so both
the clone and the remote choice pick it up; for a dual-host repo the
github.com side is left alone, as with `features`. `fetchPullRequest` now
tolerates a pull request response with no `base.repo` block at all.
