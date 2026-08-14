---
"@in-the-loop-labs/pair-review": patch
---

Fixed the council composition preview on the repository settings page for councils created before councils had a type. Those legacy councils are level-centric, and the page was drawing them with the standard (voice) layout — an empty reviewer list under a meaningless level summary — directly beneath a dropdown badge that read "Advanced". They now render the advanced layout, with their per-level reviewers, matching the badge and matching how the same council is previewed on the global settings page.
