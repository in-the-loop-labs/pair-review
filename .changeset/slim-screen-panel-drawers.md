---
"@in-the-loop-labs/pair-review": patch
---

Fix the Review, Chat and file navigator panels being unreachable on slim screens

- Below 900px (1200px for the file navigator) the panels were hidden, but their toolbar
  toggles stayed visible and did nothing. The panels now open as drawers over the diff,
  just below the toolbar, so the toggles keep working and the diff keeps its full width.
- Wider than 900px, Review and Chat also float over the diff instead of sitting beside it
  when that would leave the diff too narrow to read (for example both panels at ~950px).
- On very narrow screens, Review and Chat open together stack one above the other instead
  of squeezing side by side, and the layout picker only offers the stacked layouts. Your
  chosen layout is kept and comes back when the window is wide enough.
- The file navigator drawer closes when you pick a file and doesn't change whether the
  navigator is collapsed on wider screens.
- With the file navigator collapsed, the Review and Chat panels can now be resized wider.
  The size limit no longer reserves room for the hidden navigator.
- The toolbar no longer overlaps the guided-tour bar when the bar's text wraps on narrow
  screens.
