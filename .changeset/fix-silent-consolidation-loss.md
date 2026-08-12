---
"@in-the-loop-labs/pair-review": patch
---

Fix consolidation silently dropping all suggestions on JSON parse failure (#560)

- JSON extraction now repairs unescaped control characters (raw newlines, tabs, etc.) inside string literals before giving up, recovering large consolidation responses that embed code snippets.
- If a consolidation response still cannot be parsed while the per-level or per-voice input was non-empty, the run now falls back to the unconsolidated suggestions and reports `consolidation: 'failed'` instead of returning success with zero suggestions. This applies to all consolidation paths: cross-level orchestration, cross-voice council consolidation, and intra-level council consolidation.
- The live progress indicator no longer overwrites a failed consolidation step with "completed" when the run finishes (PR mode, local mode, and council runs).
