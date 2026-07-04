---
"@in-the-loop-labs/pair-review": patch
---

Render file-level external review comments (GitHub `subject_type: "file"`) in the per-file comments zone above the diff instead of as a bogus line-1 annotation. The GitHub sync adapter now flags these rows `is_file_level` and nulls their line anchors, the sync route no longer discards them as lost anchors, and the Review panel's External segment labels them "(file)" and scrolls to the zone card. A manual refresh repairs previously mis-synced rows. Adds schema migration 49 (`external_comments.is_file_level`).
