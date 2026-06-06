---
"@in-the-loop-labs/pair-review": patch
---

Surface user-visible toast feedback when the toolbar tour/summary generate button can't kick off a job. Previously, clicking the button when `auto_generate: false` and the review had no diff (or the request failed) silently did nothing — making the button appear broken. Now the user sees:

- An info toast ("No tour to generate." / "No summaries to generate.") when the diff is empty.
- An error toast when the HTTP request fails or the server declines for an unknown reason.
