---
"@in-the-loop-labs/pair-review": patch
---

Show "viewed" state for files in the sidebar

Files marked as viewed (and therefore collapsed in the diff panel) now display a gray filename and an eye-slash icon in the sidebar file list. The indicator updates in-place when viewed state is toggled, so the sidebar stays in sync with the diff panel without a full re-render.
