---
"@in-the-loop-labs/pair-review": patch
---

Fix two diff-parsing faults that could misplace or reject review comments.

**Hunk content that looks like a file header is no longer read as one.** The
diff parsers ran their file-header check before establishing whether they were
inside a hunk body, and inside a body those prefixes are ordinary code: a
deleted `-- note` line is emitted as `--- note`, an added `++ marker` as
`+++ marker`, and an unindented `++i;` as `+++i;`. Each was swallowed as a
header. The path recorded for the file became a fragment of the source line, so
the file the review actually changed looked absent from the diff while a path
that never existed looked present — and because the swallowed lines were never
counted, every line number after them in that file was off by one, quietly
anchoring a comment to code nobody pointed at. Diffs with no `diff --git` lines
at all, which separate files with only the `---`/`+++`/`@@` triple, are now
split into files correctly as well.

**File paths are decoded the way git wrote them.** Git terminates a name
containing a space with a TAB, and C-quotes any name with non-ASCII bytes, a
quote, a backslash or a tab — `"a/caf\303\251.txt"` — and the parsers were
keeping the TAB or the quotes and escapes verbatim. Different parts of the app
then spelled the same file differently: the patch for a quoted name went missing
entirely, and submitting a local review could report a file you were looking at
as outside the pull request and refuse the whole submission. Every diff parser
now derives paths through one shared decoder, so the file list, the rendered
patch and the submit-time check agree byte for byte. Local mode's changed-file
list decodes the same way, which also fixes adding a context file for a
non-ASCII path that was already in the diff.
