---
"@in-the-loop-labs/pair-review": patch
---

Keep long file paths and AI suggestion titles on one line in narrow panes

- Long file paths in diff headers no longer wrap onto several lines. They truncate from the front, GitHub-style ("…/deep/folder/file.js"), so the file name stays visible.
- AI suggestion titles truncate at the end, and shrink before the badges next to them. The "AI Suggestion" badge is no longer clipped and "Nice Work" no longer wraps while the title still has room.
- Hovering truncated text shows the full text in the browser's tooltip. Text that fits gets no tooltip of its own, so a collapsed suggestion still shows its "Dismissed" or "Adopted" tooltip.
