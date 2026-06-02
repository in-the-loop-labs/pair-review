---
"@in-the-loop-labs/pair-review": patch
---

Chat-about on a tour stop now includes the code snippet even when the stop targets a context file outside the PR diff. Previously the snippet enrichment only worked for stops inside the diff, so stops on auto-added context files were sent to the agent with only title/description/file/line — exactly the case where the snippet is most useful, because the file isn't visible in the diff. The chat panel now falls back to the file-content API and slices a small window (±5 lines) around the stop's line range when no diff hunk is available.
