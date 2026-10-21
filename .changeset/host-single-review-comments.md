---
"@in-the-loop-labs/pair-review": patch
---

Add a `pending_review_comments_batch` option for alt-host repositories whose pending-review comments endpoint accepts one comment per request. Setting it to `false` sends each comment in its own request instead of a single `{ "comments": [...] }` batch, which such hosts reject. A comment the host rejects with a 400 or 422 fails on its own; any other error stops the submission and reports the remaining comments as skipped. Batch requests remain the default.

`pending_review_comments_endpoint` (and the new option) no longer fail startup validation on an alt-host that leaves `pending_review_comments` at its default `"host"` mode.
