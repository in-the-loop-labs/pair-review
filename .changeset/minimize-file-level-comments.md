---
"@in-the-loop-labs/pair-review": patch
---

Extend minimize comments mode to file-level comments

When minimize mode is active, file-level comment cards are now hidden alongside line-level comments. An indicator button is injected into each file header showing icons and counts for user comments, adopted suggestions, and AI suggestions — matching the existing line-level indicator pattern. Clicking the indicator toggles visibility of that file's comments.

Additional fixes:
- File-comment indicator hover now uses typed color variants (purple for user/adopted, amber for AI) matching line-level indicators
- Replace undefined `--ai-accent` CSS variable with canonical `--color-accent-ai` across all indicator styles
- Fix `scrollToComment` in AIPanel to call `expandForElement` before scrolling, so minimized comments become visible when navigated to
- Auto-expand newly created or adopted comments in minimize mode so they don't vanish immediately after creation
