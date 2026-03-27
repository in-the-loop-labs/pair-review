---
"@in-the-loop-labs/pair-review": patch
---

Fix PR description popover clipped by overflow:hidden on header container. The popover is now appended to document.body with fixed positioning so it renders above all content regardless of ancestor overflow rules.
