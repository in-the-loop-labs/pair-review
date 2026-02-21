---
"@in-the-loop-labs/pair-review": patch
---

Gate chat panel behind config and Pi availability

Chat UI is now hidden by default until both `enable_chat` is true in config and
the Pi AI provider is detected. Three states control visibility: `disabled`
(chat feature off — everything hidden), `unavailable` (enabled but Pi not
installed — toggle button shown grayed-out with tooltip), and `available` (fully
functional). Early inline script in HTML prevents flash of chat UI before config
loads.
