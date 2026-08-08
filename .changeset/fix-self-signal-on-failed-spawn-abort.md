---
"@in-the-loop-labs/pair-review": patch
---

Fix pair-review terminating itself when an analysis was cancelled while the provider CLI had failed to spawn.

`wireAbortToChild` called `child.kill('SIGTERM')` unconditionally. When the spawn had failed — a missing or misconfigured CLI command, or an abort arriving before the process was up — the child has no pid, and Node coerces the undefined pid to `0`. `kill(0, SIGTERM)` signals the *caller's own process group*, so cancelling such an analysis delivered SIGTERM to the pair-review server itself. Verified directly: the call returned `true` and the current process received SIGTERM.

The kill is now skipped when the child has no pid, matching the guard the shell-mode branches already applied. The pending `error`/`close` handler still settles the request, so cancellation continues to reject as before. This affected every CLI provider, since all of them share this wiring.

Cancellation was not the only way to reach the bad kill. The same guard now covers every place the AI layer terminates a spawned CLI: the per-level timeout handlers, the shared LLM JSON-extraction helper, the availability probes, and — most importantly — the stdin write-error handlers, which a failed spawn reaches directly, since it EPIPEs stdin and then killed a pidless child. In shell mode, timeout and stdin-error kills of the analysis child now signal the whole process group, so a timed-out CLI grandchild stops burning tokens instead of being orphaned behind its shell wrapper.
