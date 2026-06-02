---
"@in-the-loop-labs/pair-review": minor
---

Restructure tours and hunk-summaries configuration into nested objects with a
new `auto_generate` flag, and add click-to-generate toolbar behavior.

Config shape (replaces the previous flat `tours_enabled` / `summaries_enabled`
/ `tour_provider` / `tour_model` / `summary_provider` / `summary_model` /
`summaries_max_files` / `summaries_max_lines_added` keys):

```json
{
  "tours":     { "enabled": false, "auto_generate": true, "provider": "", "model": "" },
  "summaries": { "enabled": false, "auto_generate": true, "provider": "", "model": "", "max_files": 50, "max_lines_added": 3000 }
}
```

- `enabled` gates whether the feature is available at all (toolbar button
  visibility, per-file toggles).
- `auto_generate` (new) controls whether generation kicks off automatically
  when a review loads. When `false`, generation is deferred until the user
  clicks the toolbar button.
- New manual-trigger endpoints back the click-to-generate flow:
  `POST /api/pr/:owner/:repo/:number/jobs/{summary,tour}/start` and
  `POST /api/local/:reviewId/jobs/{summary,tour}/start` (409 when the feature
  is disabled, idempotent when a job is already in flight).
- Toolbar button states: colorless before anything is generated, a pulsing
  outline while generating, and the active (colored) state once results exist.

This is a breaking change to the configuration file shape, but the feature is
unreleased so no existing users are affected.

Note: manual E2E verification of the toolbar button states (colorless
pre-generation, pulsing while generating, active when done) in both PR and
Local mode is still needed.
