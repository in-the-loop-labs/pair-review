---
"@in-the-loop-labs/pair-review": patch
---

Fix AI suggestions not displayed for renamed files and improve rename UI

- Resolve git rename syntax upstream in `getChangedFiles()` so plain new filenames flow through the DOM consistently
- Display GitHub-style rename icon in file navigator sidebar with tooltip showing old path
- Show old → new path in diff file headers for renamed files
- Distinguish pure renames from renamed+modified files in sidebar status
- Color additions green and deletions red independently in file navigator
- Fix leading-slash and double-slash bugs in rename path resolution
- Support compact rename syntax without spaces around arrow
