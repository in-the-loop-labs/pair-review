---
"@in-the-loop-labs/pair-review": minor
---

Guided-tour stops are now always reachable. Previously, a stop whose anchor line was folded out of the rendered diff — or whose file wasn't in the diff at all — silently jumped the bar to "Tour complete" without the user ever seeing that stop (the bar's "of N" count includes those stops but only the mountable ones could actually be navigated to). The navigator now unfolds covering gaps via the existing context-expand path and auto-adds out-of-diff files as transient context files (cleaned up on tour exit), so "Stop 7 of 8" → Next reliably shows Stop 8.

Also fixes three race conditions in the new async tour-navigation path: (1) exiting during an in-flight `ensureContextFile` POST no longer leaks a context file into the user's persistent list (rolled back directly when the tour is gone); (2) restarting the tour now drains pending context-file DELETEs before the new tour mounts, so a stale teardown can't rip the new tour's wrapper out from under an active stop; (3) the `_advanceTour` re-entrance latch is now generation-scoped, so exiting during a Next press no longer wedges the next reopen.
