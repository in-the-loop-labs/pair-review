---
"@in-the-loop-labs/pair-review": minor
---

Add semantic hunk-summary backend (gated behind `summaries_enabled` config flag). When enabled, review load triggers a background job that classifies trivial vs non-trivial hunks, batches LLM calls per file via the configured `summary_provider`, and broadcasts `review:hunk_summaries_ready` events as files complete. Non-executable providers only; executable providers (Claude Code etc.) are skipped to avoid contract mismatch. New `GET /api/reviews/:reviewId/hunk-summaries` endpoint returns persisted rows. Frontend rendering arrives in a follow-up.
