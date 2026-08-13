---
"@in-the-loop-labs/pair-review": patch
---

pair-loop skill: forbid running review rounds inside a subagent

A council round is a 15–40 minute background process owned by the session
that spawned it, so a round launched from a subagent is killed the moment
that agent returns — the council work is discarded and the JSON result never
arrives. The skill now carries this as a hard rule, repeats it at the point
where the round command is launched, and clarifies that delegating the
implementation and fix steps is still safe because that work completes inside
the agent.
