---
"@in-the-loop-labs/pair-review": patch
---

Fix panel width CSS variable and layout issues

- Fix --sidebar-width and --ai-panel-width CSS variables not updating when panels collapse
- Fix flicker when toggling file navigator sidebar by removing max-width transitions and batching updates in requestAnimationFrame
- Fix asymmetric spacing on comments and suggestions using margin: auto and reduced max-width padding
- Extract helper method for sidebar initialization and improve code consistency
