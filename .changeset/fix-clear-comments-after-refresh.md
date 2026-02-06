---
"@in-the-loop-labs/pair-review": patch
---

Fix clearing user comments not working after diff refresh

After refreshing the diff (in both Local and PR mode), the DOM is cleared by `renderDiff()` but comments and AI suggestions were not re-rendered. This caused `clearAllUserComments()` to find zero DOM elements and bail with "No comments to clear". Now both `refreshDiff()` and `refreshPR()` reload user comments and AI suggestions after re-rendering the diff, preserving the selected analysis run ID.
