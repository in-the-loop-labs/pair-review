---
"@in-the-loop-labs/pair-review": patch
---

Fix comment count synchronization issues

- Fixed ReviewModal.submitReview() and PRManager.submitReview() to count both line-level and file-level comments for validation
- Added updateSegmentCounts() call in AIPanel.updateComment() to ensure UI updates when comment status changes
- Added documentation explaining the intentional difference between segment counts (inbox size) and submission counts (active only)
