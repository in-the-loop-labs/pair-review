---
"@in-the-loop-labs/pair-review": minor
---

Add notification sounds for analysis and setup completion

Play a system sound when AI analysis completes or PR setup finishes, so users working in other windows get an audible alert. Sounds are played server-side using platform-native commands (macOS `afplay`, Linux `paplay`, Windows PowerShell) via a new `POST /api/play-sound` endpoint, bypassing browser autoplay restrictions.

A bell icon in the header toolbar opens a dropdown to toggle sounds per event type. Preferences are stored in localStorage and default to off. The bell icon swaps between bell/bell-slash (Octicons) to indicate state. Setup sounds are PR-mode only (local setup is instant).
