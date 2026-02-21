---
"@in-the-loop-labs/pair-review": patch
---

Fix chat showing as unavailable on first load

Await provider availability check before the server starts listening so the
`/api/config` endpoint returns accurate `pi_available` status on the very first
request. Previously the check ran in the background after `app.listen()`,
causing a race where the frontend would fetch config before the cache was
populated, making chat appear unavailable until a page reload.
