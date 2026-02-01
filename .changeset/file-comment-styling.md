---
"@in-the-loop-labs/pair-review": patch
---

Fix file-level user comment styling to match line-level comments

- Add purple gradient background, border, and shadow to file-level user comment cards in both light and dark themes
- Use `var(--file-comment-bg)` as gradient end color so cards blend with their container zone background
- Set file-comment headers to transparent so the gradient shows through consistently
