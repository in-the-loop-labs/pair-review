---
"@in-the-loop-labs/pair-review": patch
---

Fix unreliable Clear All button in review dropdown menu

The Clear All button in the split button dropdown was sometimes unresponsive, requiring a page refresh. This was caused by event listeners being orphaned when the dropdown menu was rebuilt during async operations. Fixed by using event delegation so clicks are always handled regardless of DOM updates.
