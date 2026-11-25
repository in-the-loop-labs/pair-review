---
"@in-the-loop-labs/pair-review": minor
---

Draw the diff pane with one virtualized viewer (`@pierre/diffs` `CodeView`) instead of one renderer per file. Only the files near the viewport are in the page, so the first rows of a large pull request appear sooner (frame times while scrolling are unchanged), and every feature of the pane (comments, suggestions, hunk summaries, tours, external threads, chat links) works on a file whether or not it is on screen.

What you may notice:

- **Context files** (files outside the diff that are pulled into the pane) are drawn by the same viewer as changed files: syntax highlighting like the rest of the diff, one line-number column, and the viewer's separators ("N unmodified lines") for hidden lines. A hidden run of five lines or fewer is shown instead of folded, and a very large context file (over 400 KB or 12,000 lines) is shown without highlighting. Their position among the changed files and everything you can do on their lines is unchanged.
- **Highlighting on large pull requests.** The cap on the total amount of highlighted code per page is gone; files far down a large diff are now highlighted when you reach them. The per-file limits are unchanged.
- **Jumps and layout.** Navigating to a comment, finding or tour stop in a file far away goes there directly. Switching between unified and split keeps the line you were reading in place, as does a re-render (whitespace toggle, refresh). A chat link to a line in a file that has not been on screen yet now arrives and flashes the line. A file's hidden lines no longer load underneath a comment you are typing in that file.
- **Find in page.** The browser's find (Cmd/Ctrl+F) only sees the files currently near the viewport, because the others are not in the page. An in-app search over the whole diff is planned as a follow-up.
- If the viewer's script fails to load, the diff pane shows an error message instead of a fallback rendering.

The page no longer loads highlight.js from a CDN.
