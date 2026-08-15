---
"@in-the-loop-labs/pair-review": minor
---

Derive the "GitHub or Graphite" copy from config instead of hardcoding it

The landing-page PR input, its validation errors, and the local-review "that's a URL, not a path" error now name the hosts pair-review is actually configured for, rather than always naming GitHub and Graphite.

- **Graphite is only named when `enable_graphite` is on.** It defaults to `false`, so a default install no longer advertises a feature the user has not enabled.
- **Alt hosts are named from `repos[*].links.external.name`.** An alt host configured per `docs/alt-host.md` now appears in the copy automatically — "Enter GitHub, Graphite, or Meteorite PR URL" — with no downstream patching of shipped strings.
- `GET /api/config` gains `pr_host_names`, `pr_host_list`, and `pr_url_hostnames`.

Related fixes:

- A scheme-less alt-host PR URL pasted into the local-path box (`meteorite.example/owner/repo/pull/1`) is now recognised as a URL instead of being resolved as a directory name. Previously only `github.com` and Graphite domains were detected. This also covers an alt host configured with a scheme-less `api_host` (`ghe.example.com`) or pasted with an explicit port (`ghe.example.com:8443/...`).
- `pair-review --local <alt-host URL>` is re-checked once config is loaded, so the headless and instruction-handoff branches no longer treat a scheme-less alt-host URL as a directory name.
- Where no configuration is available yet (CLI argument parsing, and the landing page before `/api/config` resolves), the copy is host-neutral — "Pass PR URLs as PR review inputs instead" — rather than naming GitHub alone and implying Graphite/alt-host URLs are unsupported.
- The "that's a URL" error now carries a stable `code` (`LOCAL_PATH_IS_URL`). Callers that previously compared its message text — which now varies per installation — branch on the code instead.
- The `enable_graphite` description in Global Settings, the README, and the config defaults now mentions that the flag also controls whether Graphite is named in the PR URL prompts and errors (Graphite URLs are accepted either way).
