---
"@in-the-loop-labs/pair-review": minor
---

Add "system" theme option that follows `prefers-color-scheme` (OS dark/light schedule).

The theme toggle now cycles through three states: light → dark → system → light.
When "system" is selected, pair-review automatically matches the OS theme and
responds to real-time changes (e.g., macOS Auto appearance schedule).

- Landing page, PR review, local review, settings, and repo-settings pages all support the new system option
- Theme icon updates to a monitor/display icon when in system mode
- System preference changes are listened for and applied immediately when system mode is active
- @pierre/diffs integration respects the system preference
