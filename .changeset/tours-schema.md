---
"@in-the-loop-labs/pair-review": minor
---

Add `tours` table (schema v46) and `TourRepository` for storing per-review guided-tour walkthroughs. Tours are cached per diff via a `diff_hash` column. Foundation for the agentic tour-generation pipeline.
