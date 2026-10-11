---
"@in-the-loop-labs/pair-review": patch
---

Handle non-ASCII and quoted file paths. Files with accented, CJK or emoji names, and files whose names contain quotes or backslashes, now show their real names in the file list and diff, keep their patches, and anchor comments and AI suggestions in both PR and Local reviews. Renamed files are recorded as renames even when the old and new paths share nothing, and a file literally named like a rename (`a => b.md`) is no longer mistaken for one. Refresh an existing review to respell paths it cached before this fix.
