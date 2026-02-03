---
"@in-the-loop-labs/pair-review": minor
---

Enhance code-critic:loop skill with history tracking and merge readiness

- Add directory-based history structure (.critic-loop/{id}/) with numbered analysis and implementation files that persist across iterations
- Aggregate custom instructions into analysis with objective context, iteration tracking, and history references to prevent re-suggesting already-addressed issues
- Add merge readiness assessment (ready/needs-fixes/blocked) to analysis output for smarter completion logic
- Update evaluation to stop early when merge readiness is "ready" instead of chasing perfection to max iterations
- Add implementation summary files documenting what was built/fixed in each iteration
- Fix iteration naming ambiguity: clarify that `iteration: 0` tracks completed cycles, use glob patterns instead of bash-like notation, and introduce explicit `CURRENT = N + 1` variable to eliminate off-by-one confusion
