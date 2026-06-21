---
"@in-the-loop-labs/pair-review": patch
---

Fix AI suggestions and comments on trailing unchanged lines failing to expand and anchor after lazy diff rendering. The end-of-file gap is created with sentinel coordinates and resolved asynchronously as each file body renders; with lazy bodies that resolution no longer completed before `expandForSuggestion` tried to match the gap, so a suggestion targeting an unchanged line after the last hunk silently failed to expand, was not navigatable from the sidebar, and stayed hidden even after manual expansion. The gap-expansion path now awaits that per-file end-of-file validation before matching, so trailing-context suggestions reveal and anchor correctly in both PR and Local modes.
