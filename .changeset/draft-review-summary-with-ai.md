---
"@in-the-loop-labs/pair-review": minor
---

Add "Draft with AI" to the Submit Review modal. A new link next to "Copy AI
summary" opens the chat panel in a fresh conversation tab to draft the review
summary, seeded with your current summary text (if any) plus the PR/review
context. The chat's action bar
then shows a "Use as review summary" button (mirroring the findings-chat
"Create comment" action) that pulls the AI's latest reply back into the summary
field, preserving the selected review type. The link is hidden for Draft reviews
(whose body is not sent) and when no chat panel is available.
