---
"@in-the-loop-labs/pair-review": patch
---

Fix stale-check fetch blocking dialog by using AbortController

The stale-check fetch used a simple sequential `await fetch()` with no timeout. If the
underlying HTTP connection hung (e.g., slow git commands on some machines), it could
exhaust the browser's per-origin connection limit (~6), blocking subsequent fetches and
delaying or preventing the analysis config dialog from appearing.

Switch to AbortController with a 2-second timeout so the fetch is truly cancelled,
immediately freeing the connection. Additionally, run the stale check in parallel with
the settings fetches via Promise.all to minimize dialog delay. Applied to both local
and PR mode.
