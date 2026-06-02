---
'@in-the-loop-labs/pair-review': patch
---

- Cancel-job helper now only clears the toolbar pulse on HTTP 200 (cancelled) or 404 (already gone); 4xx/5xx/network failures keep the active state and surface an error toast so the user can retry.
- Guard the tour/summary cancel-confirm dialog against re-entry: a rapid second click on the pulsing toolbar button while the singleton ConfirmDialog is already open is now dropped instead of orphaning the first invocation's Promise.
