---
"@in-the-loop-labs/pair-review": patch
---

Shut down chat agent processes after 10 idle minutes (configurable via `chat.idle_timeout_minutes`, `0` disables) so closed browser tabs no longer leave agents running; the conversation resumes transparently on the next message.
