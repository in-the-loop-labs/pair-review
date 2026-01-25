---
"@in-the-loop-labs/pair-review": patch
---

Disable hooks when invoking Claude CLI for AI analysis

When pair-review invokes Claude CLI for AI analysis, it now passes `--settings '{"disableAllHooks":true}'` to prevent project-configured hooks from running during the analysis. This avoids slowdowns or interference from hooks configured in the repository being reviewed.
