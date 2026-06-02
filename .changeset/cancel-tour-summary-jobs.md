---
"@in-the-loop-labs/pair-review": minor
---

Add a user-facing cancel for in-flight tour and hunk-summary generation. Clicking the pulsing tour or summary toolbar button while a job is running now opens a confirmation dialog ("Cancel Tour" / "Cancel Summaries" vs "OK"). On confirm, the background job aborts and the upstream AI CLI call is killed so token spend stops immediately.

Backend: `BackgroundQueue` jobs now receive an `AbortSignal`, which is plumbed through tour/summary generators into every non-executable provider (Claude, Gemini, Codex, Copilot, Cursor Agent, OpenCode, Pi). A new `POST /api/reviews/:reviewId/jobs/:jobKey/cancel` endpoint (plus a `/api/local/...` mirror) cancels by bare prefix (`tour` | `summaries`) or full composite key. Works in both PR and Local modes.
