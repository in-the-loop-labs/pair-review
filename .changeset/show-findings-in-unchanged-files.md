---
"@in-the-loop-labs/pair-review": minor
---

Keep AI findings on files the review did not change, in both PR and Local reviews. Level 3 (codebase context) analysis may now report findings in such files; Levels 1 and 2 still stay on the changed files. A finding is kept when its file exists in the checkout the AI read, and that file is added to the diff panel as a context file around the first finding in it. Selecting a council reviewer adds the context files for that reviewer's findings. A context file can't be removed while it shows an active finding or comment. Comments on unchanged files stay in pair-review when a review is submitted to GitHub, with a notice listing them; headless reviews skip and log them.
