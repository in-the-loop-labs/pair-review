---
"@in-the-loop-labs/pair-review": patch
---

Fix alt-host review submission failing at "Step 1: Creating pending review" with HTTP 400 `{ message: "request body is empty" }`. The REST `addPullRequestReview` now sends an explicit empty `body: ''` when creating a pending review, so the serialized HTTP request body is non-empty (`{"body":""}`). github.com tolerates an empty POST body, but strict GitHub-compatible alt-hosts (repos configured with an `api_host`) reject it. The review still stays PENDING (no `event` is sent), and `github.com` behaviour is unchanged.
