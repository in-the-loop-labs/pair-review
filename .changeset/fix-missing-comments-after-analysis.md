---
"@in-the-loop-labs/pair-review": patch
---

Fix user comments disappearing from Review panel after AI analysis completes

`clearAllFindings()` was clearing both AI suggestions and user comments when a new
analysis started. Since the analysis completion handler only reloaded AI suggestions,
user comments were lost until a page refresh. Now `clearAllFindings()` preserves user
comments, and the analysis completion handler reloads both suggestions and comments.
