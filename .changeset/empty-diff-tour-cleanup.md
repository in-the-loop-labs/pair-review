---
"@in-the-loop-labs/pair-review": patch
---

Fix stale guided-tour stops surviving a diff-emptying refresh or scope change.
When `kickOffTourJob` was called with an empty diff, the in-flight worker was
cancelled and the supersede sentinel was stamped, but the persisted `tours`
row was left untouched — `GET /api/reviews/:id/tour` serves the stored row
without comparing `diff_hash`, so the UI kept offering stops pointing at lines
no longer in the diff (reachable by reverting all unstaged changes or flipping
scope to a range with no changes). The empty-diff path now unconditionally
deletes the persisted row and broadcasts `review:tour_ready` so open clients
re-fetch and see `{tour: null}`. Cleanup runs even on the first kickoff after
a server restart (when the in-memory supersede map is empty but a pre-restart
row still exists); `deleteByReview` is idempotent and the broadcast is gated
on `changes > 0` so fresh reviews stay silent.
