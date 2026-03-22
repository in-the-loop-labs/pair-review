---
"@in-the-loop-labs/pair-review": patch
---

fix: fire review.started hook when PR review is created for the first time

Previously, the review.started hook never fired for PR reviews because the
database record was created during CLI/web setup (storePRData), and the GET
route's getOrCreate then found the existing record and fired review.loaded
instead. Now storePRData reports whether the review is new, and the setup
paths (setupPRReview and main.js CLI) fire review.started directly.
