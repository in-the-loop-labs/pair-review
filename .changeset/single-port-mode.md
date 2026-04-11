---
"@in-the-loop-labs/pair-review": minor
---

Add single-port mode: reuse one pair-review server across invocations

By default, pair-review now uses a single server on its configured port (7247). A second invocation detects the running server via `/health`, opens the appropriate URL in the browser (PR, local, or landing page), and exits without touching the database or starting a second server. This keeps bookmarks, MCP configs, and user expectations stable instead of picking a new fallback port each time.

When a newer CLI invocation hits an older running server, the older server surfaces a dismissible corner-card update banner in the web UI — "pair-review vX.Y.Z is available. Restart the server to update." — so users know to restart.

New config key:
- `single_port` — defaults to `true`. Set to `false` in `~/.pair-review/config.json` to restore the previous automatic-port-selection behavior (useful for running multiple dev instances simultaneously).

Headless modes (`--ai-review`, `--ai-draft`) bypass delegation and continue to bind the configured port directly.
