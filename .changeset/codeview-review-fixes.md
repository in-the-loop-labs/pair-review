---
"@in-the-loop-labs/pair-review": patch
---

Fix several diff-pane bugs:

- GitHub review threads on a file marked Viewed or generated are now shown under their lines when you open the file, instead of in the file's comment area styled as threads whose lines are gone.
- Guided tour stops in a file marked Viewed or generated are no longer skipped: the tour opens the file, shows the stop on its line, and collapses the file again when the tour ends.
- "Insert a suggestion" puts exactly the selected lines in the suggestion block, without an empty line after each one (which added blank lines when the suggestion was applied on GitHub).
- "Insert a suggestion" now refuses, with a warning, a range that includes lines the diff does not show, where it used to insert a block of only the shown lines (which deleted the others when the suggestion was applied on GitHub).
- Double-clicking Save, or pressing Cmd/Ctrl+Enter twice, no longer saves the same comment twice.
- A comment on a selected range that starts on a line whose comment form is already open now gets a form of its own and is saved with the whole range, instead of reusing the open form and saving only that one line.
