---
"@in-the-loop-labs/pair-review": patch
---

Add dismiss (×) button to chat action bar and `chat.enable_shortcuts` config option

- Small × button on the action bar to hide stale shortcut buttons mid-conversation
- `chat: { enable_shortcuts: false }` in config globally disables action bar shortcuts
- One-level deep merge for nested config objects prevents silent loss of defaults
