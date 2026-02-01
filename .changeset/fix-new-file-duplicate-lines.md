---
"@in-the-loop-labs/pair-review": patch
---

Fix duplicate lines in diff display for new files

- New files showed all added lines AND an expandable "hidden lines" gap that, when expanded, repeated the entire file content
- Root cause: `patch.split('\n')` on newline-terminated diff output produces a trailing empty string that gets misclassified as a context line with oldNumber=0, making `prevBlockEnd.old = 0` instead of staying unset — this caused the EOF gap check to pass when it shouldn't
- Strip trailing empty strings from parsed hunk blocks before rendering
- Tighten EOF gap guard from `prevBlockEnd.old + 1 > 0` to `prevBlockEnd.old > 0` so files with no old-side content (new files) never get a trailing expand section
- Also guard EOF validation to immediately remove gaps with startLine <= 0
