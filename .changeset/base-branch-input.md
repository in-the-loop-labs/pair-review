---
"@in-the-loop-labs/pair-review": minor
---

Add an editable base branch field to the diff scope selector

When the branch stop is in scope on a local review, the diff options
dropdown now shows a "Base branch" input. Editing it regenerates the
scoped diff against the new base (for example `origin/main` when the
local `main` ref is behind), instead of relying solely on automatic
base branch detection.
