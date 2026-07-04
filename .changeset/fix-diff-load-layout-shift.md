---
"@in-the-loop-labs/pair-review": patch
---

Fix layout shift on diff load: the diff briefly rendered centered with extra padding, then snapped left. The container's loading state flag shared the `.loading` placeholder class (48px padding + centered text, which inherits into the @pierre/diffs shadow DOM). The state flag is now `is-loading`, and the diff container explicitly sets `text-align: start`.
