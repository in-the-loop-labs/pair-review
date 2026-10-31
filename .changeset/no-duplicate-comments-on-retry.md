---
"@in-the-loop-labs/pair-review": patch
---

Stop duplicate review comments on GitHub when a submit request fails after GitHub may already have added the comments (a timeout, dropped connection or server error). Pair-review now re-sends a batch of comments only when GitHub cannot have applied it, such as a refused connection or an error GitHub returned before running the request.
