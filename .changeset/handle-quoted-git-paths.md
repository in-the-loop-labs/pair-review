---
"@in-the-loop-labs/pair-review": patch
---

Handle non-ASCII and quoted file paths. Files with accented, CJK or emoji names, and files whose names contain quotes or backslashes, now show their real names in the file list and diff, keep their patches, and anchor comments and AI suggestions in both PR and Local reviews, including inline comments submitted to GitHub. Inline comments on files whose names contain a space are no longer turned into file-level comments when the review is submitted. Sparse-checkout directories with non-ASCII names are recognized, so they are no longer re-added on every PR setup or shown escaped to the AI. The code-critic plugin's annotated diff names these files the same way. Renamed files are recorded as renames even when the old and new paths share nothing, and a file literally named like a rename (`a => b.md`) is no longer mistaken for one. Refresh an existing review to respell paths it cached before this fix.
