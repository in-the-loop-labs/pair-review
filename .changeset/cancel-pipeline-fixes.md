---
"@in-the-loop-labs/pair-review": patch
---

Harden the cancel pipeline for in-flight tour and hunk-summary generation:

- Cancelling now reliably kills shell-wrapped provider CLIs (e.g. `devx claude`). Previously the SIGTERM only reached the shell wrapper while the CLI grandchild kept burning tokens. Shell-mode spawns are now detached and group-killed via `process.kill(-pid, …)` (`taskkill /T /F` on Windows).
- Clicking Cancel and immediately clicking Generate again now starts a fresh job. Before, the second click silently inherited the about-to-reject promise because the cancelled key was not evicted from the dedup map.
- Cancelling a job that was still queued (waiting on concurrency) now rejects it immediately and prevents the worker from being invoked with an already-aborted signal. `hasActiveForReview` also clears right away.
- Timed-out provider calls no longer leak an abort-event listener on the per-job AbortSignal. Tour and summary jobs reuse one signal across many provider calls, so the leak previously accumulated one listener per timed-out call until the job ended.
- When a cancelled worker's rejection lands after the same key was re-enqueued, the settling worker no longer clobbers the replacement job's bookkeeping. Previously the replacement became invisible to `hasActiveForReview`, immune to a follow-up cancel, and vulnerable to a duplicate-worker enqueue.
