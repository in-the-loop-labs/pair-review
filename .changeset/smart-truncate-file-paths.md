---
"@in-the-loop-labs/pair-review": patch
---

Long file paths in diff headers no longer wrap onto multiple lines in narrow panes. They stay on one line and truncate from the front, GitHub-style ("…/deep/folder/file.js"), so the file name stays visible. AI suggestion titles truncate at the end. In both cases, hovering truncated text shows the full text in a tooltip; nothing appears when the text already fits.
