---
"@in-the-loop-labs/pair-review": patch
---

Fix _f_ function context markers being lost during upward gap expansion. Stranded markers are now relocated to the nearest remaining gap boundary instead of being removed, preserving function scope context for collapsed code sections.
