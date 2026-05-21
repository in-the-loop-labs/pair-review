---
"@in-the-loop-labs/pair-review": patch
---

Tighten hunk_summaries schema: CHECK constraint requires at least one of `summary_text` or `trivial_reason` to be set; upsertMany validates the same invariant; and conflict updates preserve the original `created_at`.
