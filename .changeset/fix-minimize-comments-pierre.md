---
"@in-the-loop-labs/pair-review": patch
---

Fix "Minimize comments" mode under the @pierre/diffs renderer. Line-level indicators and card hiding were dead after the diff migration: AI suggestion cards were never hidden at all, and no per-line indicator appeared for comments, suggestions, or external threads. The minimizer now groups annotation cards by the vendor's stable per-line slot and hides suggestion/comment/external cards, collapsing each annotation row to zero height and floating a single clickable indicator pill over the anchor line's right edge (so minimized comments no longer break up the diff). Expansion state is restored across the renderer's rerenders, and indicators are re-injected after diff-style switches, hunk expansion, and highlight streaming. Works in unified and split view, including one-sided (entirely-added/removed) files.
