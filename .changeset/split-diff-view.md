---
"@in-the-loop-labs/pair-review": minor
---

Add split (side-by-side) diff view. A new "Diff view" toggle in the diff options menu switches between unified and split rendering, persists across sessions, and works in both PR and Local modes. Comments, AI suggestions, hunk summaries, external comments, and tour stops re-anchor into the correct column and stretch to full width across both columns (falling back to side-by-side half-width when both sides of a row are annotated), and gutter buttons, line selection, and scroll-to-line are side-aware in split mode. Annotation prose (comment bodies, AI suggestion text, hunk summaries, tour notes) is capped at a readable ~80-character measure on wide displays while cards keep spanning the diff.
