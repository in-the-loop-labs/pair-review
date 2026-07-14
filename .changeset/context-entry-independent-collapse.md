---
"@in-the-loop-labs/pair-review": patch
---

Fix context entries colliding with a same-file diff entry. The diff panel now applies the "diff wins" rule when rendering context files (a stored context row whose file has entered the diff — via Local-mode scope change, new commits, or PR refresh — is suppressed at the view layer, never deleted, and self-heals when the file leaves the diff). As defense-in-depth, context entries keep collapse/viewed state under context-scoped keys so toggling one never re-expands or re-collapses the other, `findFileElement` resolves only real diff wrappers (never a nested comments zone or a same-path context wrapper), and dismissing a context entry scrubs its scoped state keys so stale viewed/collapsed state cannot resurrect on re-add — including when the removal arrives from another tab via a WebSocket refresh.
