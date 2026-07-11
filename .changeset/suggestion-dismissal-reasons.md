---
"@in-the-loop-labs/pair-review": patch
---

Add dismissal reasons for AI suggestions. The suggestion status endpoint (`POST /api/reviews/:reviewId/suggestions/:id/status`) now accepts an optional `reason` string (≤2000 chars) that is stored and returned as `status_reason` on suggestion objects. The reason is valid only with status `"dismissed"` (400 if sent with `"active"`), and restoring a suggestion to active clears any stored reason. The loop (pair-loop plugin) and in-app chat agents write a one-sentence explanation when dismissing after discussion, and the UI renders it as a reply-styled note beneath the suggestion. Deleting a comment that was adopted from a suggestion now dismisses the parent suggestion with an auto-generated reason noting the adopted comment was removed. Documented in the chat API reference and cheat sheet (served via `GET /api.md`).
