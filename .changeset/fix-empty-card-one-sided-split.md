---
"@in-the-loop-labs/pair-review": patch
---

Fix: in split (side-by-side) view, comments on entirely added or entirely
removed files rendered as empty cards — the card border and action buttons
showed, but the header text and comment body were invisible.

Boxing a one-sided file's lone code column into the split grid made it a real
box, which activated the vendor's `contain: content` (paint containment). That
clipped the full-width-stretched annotation card's paint to the column's own
half, hiding the header and body (which stretch into the adjacent half) while
the right-aligned buttons stayed visible. The one-sided column CSS now drops
paint containment (`contain: layout style`) alongside the existing
`overflow: visible`, so the whole card paints.
