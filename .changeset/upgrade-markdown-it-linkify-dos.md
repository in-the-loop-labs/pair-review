---
"@in-the-loop-labs/pair-review": patch
---

Upgrade the bundled markdown renderer to markdown-it 14.3.2 to fix a linkify denial-of-service

markdown-it 13.0.2 bundled `linkify-it` 4.x, whose link matcher has quadratic
cost (CVE-2026-48801 / GHSA-22p9-wv53-3rq4): a comment or suggestion containing
tens of kilobytes of email-like text could freeze the review page for seconds
while it rendered. The PR and Local review pages now load markdown-it 14.3.2,
which bundles the fixed `linkify-it` 5.0.2. `markdown-it` moved to
`devDependencies`, since the browser loads it from the CDN and only the unit
tests use the npm copy.
