---
"@in-the-loop-labs/pair-review": patch
---

Fix vertical layout group resize handle not responding when chat panel is wider than review panel. The group resize handle now updates both --ai-panel-width and --chat-panel-width in tandem so the CSS max() expression always reflects the user's drag intent.
