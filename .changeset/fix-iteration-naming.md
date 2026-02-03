---
"@anthropic/code-critic": patch
---

Fix iteration naming ambiguity in code-critic:loop skill

- Add inline comment clarifying that `iteration: 0` tracks completed fix cycles
- Change bash-like `{1..N-1}` notation to glob patterns with prose descriptions
- Introduce explicit `CURRENT = N + 1` variable in Fix phase to eliminate off-by-one ambiguity
