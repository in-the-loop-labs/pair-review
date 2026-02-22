---
"@in-the-loop-labs/pair-review": patch
---

Auto-add context file when commenting on a file outside the diff

When a comment is created on a file not in the PR diff, the server now automatically creates a context file entry so the file appears in the diff panel. Inline comments on context file lines are also rendered correctly. Includes filesystem validation for context file paths and proper handling of multiple context file ranges per file.
