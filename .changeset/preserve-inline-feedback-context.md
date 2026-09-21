---
"@in-the-loop-labs/pair-review": patch
---

Fix invisible inline suggestions and comments outside diff hunks in PR and local reviews: correctly detect visible context, preserve expanded context across feedback refreshes, and reveal both ends of a range when navigating from the sidebar. Prevent older navigation requests from scrolling over a newer selection while lines are expanding.
