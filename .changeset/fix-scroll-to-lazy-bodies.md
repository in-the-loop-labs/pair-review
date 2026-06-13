---
"@in-the-loop-labs/pair-review": patch
---

Fix scroll-to landing at the wrong location on the first attempt for tour stops, AI suggestions, comments, and external threads. Lazily rendered file bodies (the large-PR perf change) shift the layout while the smooth scroll is in flight; scrolls now render the target's file body first and re-correct the position once lazy renders settle.

Also hardens the stable scroll against rapid re-navigation: a newer scroll now supersedes any older in-flight one (latest-scroll-wins) instead of snapping the viewport back to a stale target, rapid Next/Prev suggestion navigation no longer highlights the wrong target across the lazy-render await, scroll-intent keys typed into form fields no longer cancel the correction loop, and file-level comment cards skip the unnecessary full diff-body render.

Navigation now lands the target at the top of the diff panel (just below the sticky toolbar and file header) instead of the middle, for AI suggestions, findings, comments, external threads, and chat-line links.
