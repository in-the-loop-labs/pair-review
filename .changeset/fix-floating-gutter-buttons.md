---
"@in-the-loop-labs/pair-review": patch
---

Fix gutter comment/chat buttons floating over unrelated content. The fallback positioner pins the buttons with fixed viewport coordinates, but its clear routine was a no-op (falsy check against an empty-string marker), and nothing cleared the pinned position when the pointer left the diff, the page scrolled, or the diff layout was re-rendered. The buttons now clear when the pointer abandons them and re-anchor after scrolls and view toggles.
