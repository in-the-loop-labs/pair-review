---
"@in-the-loop-labs/pair-review": patch
---

Fix the shared LLM JSON-extraction fallback hanging on wrapper commands, and make it respond to cancellation.

`extractJSONWithLLM` closed the child's stdin only when the prompt was delivered over stdin or via an `@file` argument. A provider that passes the prompt as a plain CLI argument left stdin open, and while the target CLI itself ignores it, a wrapper command (`devx muse --`, `docker exec ... muse`) can block on an open stdin and hang until the 60-second extraction timeout. Stdin is now ended on every delivery path, with an `error` listener attached so a late EPIPE cannot become an unhandled exception.

The helper also ignored cancellation entirely: a user cancel fired while the extraction fallback was running could neither stop the spawn nor change the outcome. It now accepts an optional `abortSignal`, kills the extraction child when the signal fires, and rejects with an `AbortError`. An already-aborted signal skips the spawn altogether, and the abort listener is detached on every exit path so a long-lived per-job signal does not accumulate listeners. Callers that omit `abortSignal` are unaffected — every failure still resolves as `{ success: false, error }`.

Every provider now actually passes that signal through. The Claude, Codex, Copilot, Antigravity, Cursor Agent, OpenCode and Pi adapters called the extraction fallback without it, so cancelling a tour or summary during the fallback left the extraction child running to its 60-second timeout. Worse, those handlers turned the resulting cancellation into a plain `{ raw, parsed: false }` response, making a cancelled job look like one that had simply produced unparseable output. All seven now forward `abortSignal` and re-check for cancellation both after the extraction resolves and in the error path, rejecting with an `AbortError` instead of a parse failure — the behaviour the Muse provider already had.
