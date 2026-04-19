---
"@in-the-loop-labs/pair-review": patch
---

Fix Opus 4.6 model variants failing to launch

The `opus`, `opus-4.6-low`, `opus-4.6-medium`, and `opus-4.6-1m` Claude provider entries were pinned to `opus-4-6` / `opus-4-6[1m]` CLI model IDs in 3.3.4, but the Claude CLI does not accept those bare aliases — only the fully-qualified `claude-opus-4-6` / `claude-opus-4-6[1m]` IDs work. Updated all four entries to use the prefixed IDs so these models actually run.
