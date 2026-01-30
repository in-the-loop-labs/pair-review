---
"@in-the-loop-labs/pair-review": patch
---

Fix AI suggestions from `--ai-draft` not appearing in web UI

- Include `'draft'` status in AI suggestions API query filters so suggestions submitted via `--ai-draft` remain visible when viewing the PR in the browser
