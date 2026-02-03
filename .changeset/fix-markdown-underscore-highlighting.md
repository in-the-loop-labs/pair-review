---
"@in-the-loop-labs/pair-review": patch
---

Fix Markdown syntax highlighting so underscores within words (e.g. `update_policy`) are no longer incorrectly treated as italic/bold markers. Added `fixMarkdownHighlighting()` post-processing that strips mid-word emphasis/strong spans from highlight.js output.
