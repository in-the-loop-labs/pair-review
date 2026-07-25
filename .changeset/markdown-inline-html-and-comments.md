---
"@in-the-loop-labs/pair-review": patch
---

Improve markdown rendering of comments: hide HTML comments (e.g. tracking markers) from the rendered view and render the GitHub-supported inline HTML subset (`<sub>`, `<sup>`, `<kbd>`, `<ins>`, `<del>`, `<mark>`, `<details>`, etc.). Rendered output is now sanitized with DOMPurify against an explicit allowlist, so raw HTML is safe. Raw comment text is still shown when editing a comment.
