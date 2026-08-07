---
"@in-the-loop-labs/pair-review": minor
---

Stop background pool fetches from filling the disk on large monorepos (#552)

On a large monorepo, a `git fetch` that ran out of the 5-minute idle timeout was
SIGKILLed after writing its pack but before updating refs. Because
`last_fetched_at` only advanced on success, the worktree stayed permanently due
and re-downloaded the same pack every minute — and each killed fetch left an
orphaned `objects/pack/pack-*.keep` marker, which makes `git repack` silently
skip that pack so the space is never reclaimed.

- Background fetches now record every attempt, not just successes, and a failing
  worktree backs off exponentially (one interval, then two, then four, capped at
  six hours) instead of retrying on the next 60-second tick.
- Orphaned `pack-*.keep` files are cleaned up automatically after every
  background fetch attempt, so `git repack`/`gc` can reclaim the space — even
  when the marker was left by an earlier process that died outright. Only
  markers written by a dead process on this same host are removed; the packs
  themselves are never touched.
- New per-repo `fetch_timeout_seconds` setting for repositories whose fetches are
  legitimately silent for longer than the 5-minute default.
- `skip_bulk_fetch` now governs the periodic background pool fetch for that
  repository. It no longer affects the foreground refresh path, which always
  uses targeted fetches now (see the companion targeted-fetch change).
- Background fetches pass `--progress`, so git keeps emitting output during long
  quiet phases like delta resolution and the idle timeout no longer kills healthy
  fetches.
