---
"@in-the-loop-labs/pair-review": patch
---

Add missing `showInfo()` method to Toast component

The Toast class only defined `showSuccess`, `showError`, and `showWarning`, but `showInfo` was called in three places, causing runtime errors. Added the method with a GitHub-style info icon and blue styling for both light and dark themes.
