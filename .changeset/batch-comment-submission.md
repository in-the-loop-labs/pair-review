---
"@in-the-loop-labs/pair-review": patch
---

Fixed large reviews failing to submit to GitHub. Reviews with many comments are now submitted in batches with automatic retry logic, removing the previous limitation on comment count.
