---
"@in-the-loop-labs/pair-review": patch
---

Fix two diff rendering defects: a dismissed comment no longer reappears on its line when the file is re-rendered (for example after hidden lines are revealed), and an external review thread whose line is in the diff is no longer moved to the file's comment zone when its threads load while the file is still being highlighted.
