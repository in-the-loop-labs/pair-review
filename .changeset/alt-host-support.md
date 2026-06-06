---
"@in-the-loop-labs/pair-review": minor
---

Add support for self-hosted Git platforms that expose a GitHub-compatible REST API. Configure per-repo via `repos["owner/repo"].api_host`, `token` / `token_command`, `url_pattern`, `features`, and `links` keys. See `docs/alt-host.md` for the configuration guide. Existing `github.com` behaviour is unchanged.
