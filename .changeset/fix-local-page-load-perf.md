---
"@in-the-loop-labs/pair-review": patch
---

Fix slow local review page load by removing blocking GitHub API calls from the critical path. Base branch detection now runs in the background after the page responds and is cached for subsequent scope changes.
