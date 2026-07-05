---
"@in-the-loop-labs/pair-review": minor
---

feat: dual-host repositories with per-PR host resolution

A repo configured with `api_host` can now set `exclusive: false` to indicate
that its pull requests live on both `github.com` and the configured alternate
host, rather than exclusively on the alt host. pair-review resolves the host
per PR instead of per repo.

- New per-repo config boolean `exclusive` (only valid alongside `api_host`).
  Omitted or `true` keeps today's behavior (the repo lives exclusively on the
  alt host); `false` marks the repo as dual-host.
- Each PR's host is stored locally and detected from the URL pattern that
  matched a pasted URL, the host a PR was found on during a dashboard
  collections refresh, and setup-time probing for bare PR numbers (alt host
  first, falling back to github.com only on a 404 — auth/network errors fail
  loudly with no fallback).
- Dashboard collections now also list open PRs from every configured alt host,
  best-effort per host with partial results when a host is unavailable.
- Links and host-named text render per PR: a dual repo's github-hosted PR shows
  GitHub/Graphite links; its alt-hosted PR shows the configured external link.

Repos with `api_host` and no `exclusive` key behave exactly as before.
