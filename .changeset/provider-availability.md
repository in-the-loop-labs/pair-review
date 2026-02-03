---
"@in-the-loop-labs/pair-review": minor
---

Add provider availability checking at server startup

- Check all AI providers in the background when server starts, caching availability status
- Default provider is checked first for faster initial availability
- Claude provider now uses fast `claude --version` check instead of running a prompt
- Analysis config modal only shows available providers (unavailable ones are hidden)
- Added refresh button to manually re-check provider availability
- Provider buttons now wrap to multiple lines when there are many providers
- Shows helpful message when no providers are available
- Auto-selects first available provider if currently selected one becomes unavailable
