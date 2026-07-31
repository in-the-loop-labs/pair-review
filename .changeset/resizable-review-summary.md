---
"@in-the-loop-labs/pair-review": patch
---

Make the Submit Review modal's summary textarea genuinely resizable. It already
had `resize: vertical`, but a `max-height: 150px` cap limited it to ~3 visible
lines with an inner scrollbar, so the drag handle did almost nothing. The cap is
raised to `60vh` (and the default `min-height` bumped to 90px); the modal body
scrolls beyond that.
