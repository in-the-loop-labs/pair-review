---
"@in-the-loop-labs/pair-review": patch
---

Fix chat auto-scroll fighting user during streaming responses. The chat panel no longer yanks the viewport to the bottom on every streaming chunk — if the user scrolls up, auto-scroll disengages and a "New content" pill appears. Clicking the pill or scrolling back to the bottom re-engages auto-scroll. User-initiated actions (sending messages, adding context cards) always scroll into view.
