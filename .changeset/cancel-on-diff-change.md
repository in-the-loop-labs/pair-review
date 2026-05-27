---
"@in-the-loop-labs/pair-review": patch
---

Tour and hunk-summary generation now auto-cancel when the underlying diff
changes (refresh, scope change, PR HEAD update, HEAD-SHA resolution).
Cancellation is load-bearing for both cost AND correctness: it stops the
stale provider call from burning tokens, AND prevents the stale worker
from persisting summaries for hunks the user has already moved past
(summary writes are content-hash-keyed and have no upstream staleness
check). Tour persistence retains its in-generator superseded check as a
last-chance guard, fixing a race where a cancelled predecessor could
overwrite a fresh tour after the latest-hash marker had been cleared.
Whitespace toggle is unaffected — the canonical diff digest is unchanged
so the in-flight job continues.
