---
"@in-the-loop-labs/pair-review": patch
---

Fix three small review issues. File-level AI suggestion cards from a previous analysis run or level no longer linger when the new results have no file-level findings, and reloading user comments leaves the current AI cards in place. The suggestion navigator keeps its selection when suggestions refresh (for example after adopting or dismissing one), and shows an error when a finding cannot be shown in the diff instead of doing nothing. Headless `--ai-draft` / `--ai-review` submissions now post findings on deleted lines to the LEFT side of the diff instead of always using RIGHT.
