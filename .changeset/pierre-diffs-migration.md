---
"@in-the-loop-labs/pair-review": minor
---

feat: migrate diff rendering to @pierre/diffs

Replace custom table-based diff rendering with @pierre/diffs library for:
- Shiki-powered syntax highlighting for diff content (highlight.js remains
  for legacy/context-file rendering)
- Built-in hunk separator rendering with expandable context
- Shadow DOM isolation for diff content
- Annotation-based inline comments, AI suggestions, code-tour stops, and
  hunk summaries

The migration is additive — legacy table rendering is preserved as a fallback
for context file chunks and environments where the @pierre/diffs bundle is
unavailable. File headers, file tree navigation, theme switching, tours,
hunk summaries, and all existing interactions continue to work unchanged.
