---
"@in-the-loop-labs/pair-review": patch
---

Fix consolidation progress disambiguation in review councils

Per-reviewer orchestration progress updates (with voiceId) no longer pollute the shared
consolidation state (steps, consolidationStep, streamEvent). This prevents progress from
individual reviewer's cross-level orchestration from being confused with the overall
cross-voice or cross-level consolidation in the progress dialog.
