---
"@in-the-loop-labs/pair-review": patch
---

Pass full suggestion JSON to orchestration level instead of truncated text. Previously, the orchestration AI received only partial data (truncated descriptions, missing line_end, old_or_new, suggestion, and confidence fields), forcing it to re-derive information already computed by lower analysis levels. Now orchestration receives complete suggestion data, enabling accurate deduplication, proper confidence aggregation, and correct line positioning for comments.
