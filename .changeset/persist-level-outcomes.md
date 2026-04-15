---
"@in-the-loop-labs/pair-review": patch
---

Persist per-level analysis outcomes and surface them in history

The analysis-run history now shows which levels actually **succeeded** or **failed**, not just which were configured to run. A new `C` slot reflects the consolidation (orchestration) step, which previously had no indicator at all.

- Success → green ✓
- Failure → red ✗
- Skipped → neutral grey middot (`·`), replacing the old grey ✗

Outcomes are stored in a new `analysis_runs.level_outcomes` column (migration v44) so the information survives navigation and reloads. Legacy runs fall back to the existing `levels_config`-based rendering (enabled → success, disabled → skipped; no `C` slot, because historical consolidation outcome is unknown).

Council parent runs display only the `C` slot, since per-level outcomes live on the per-reviewer child runs.
