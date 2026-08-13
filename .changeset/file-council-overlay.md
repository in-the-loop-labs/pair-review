---
"@in-the-loop-labs/pair-review": minor
---

Councils can now be defined as files on disk. Council documents dropped into `~/.pair-review/councils/*.json` appear as a read-only overlay everywhere saved councils do — the analysis config selector (marked "(file)"), `--council` handles, `--list-councils` (new SOURCE column), repo/global default-council settings, and the councils API. Save As duplicates a file council into an editable database copy; the API and UI refuse in-place edits and deletes. Files are loaded once at startup — restart to pick up changes.
