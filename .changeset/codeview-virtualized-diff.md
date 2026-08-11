---
"@in-the-loop-labs/pair-review": minor
---

Migrate diff rendering to @pierre/diffs CodeView with built-in virtualization.

The diff view now renders through a single virtualized CodeView instance
instead of per-file diff components with hand-rolled lazy loading. User-visible
changes:

- Large PRs render immediately — the "Load diff" placeholder for oversized
  files is gone (very large files still fall back to plain-text highlighting).
- Smoother scrolling on large diffs: files mount and unmount as they enter
  the viewport, with sticky file headers managed by the viewer.
- Context files are now syntax-highlighted like diff files instead of plain
  tables.
- Comment, suggestion, and review counts are computed from data rather than
  visible DOM, so they stay correct for files scrolled out of view.
- Background full-file content upgrades defer while the pointer is over a
  file, so hover targets no longer shift mid-interaction.
