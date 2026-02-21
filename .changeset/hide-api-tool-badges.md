---
"@in-the-loop-labs/pair-review": patch
---

Hide tool badges for internal API calls in chat panel

Suppress tool_use SSE events when the chat agent curls the pair-review server's own API, so implementation-detail badges don't appear in the chat panel. The regex is port-scoped to avoid accidentally hiding calls to other local services.
