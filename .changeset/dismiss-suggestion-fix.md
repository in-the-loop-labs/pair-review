---
"@in-the-loop-labs/pair-review": patch
---

Fix dismissing AI suggestions when multiple suggestions exist on the same line

- Fix `collapseAISuggestion` to target the correct suggestion div instead of always finding the first one via `querySelector('.ai-suggestion')`
- Move `hiddenForAdoption` tracking from the row element to individual suggestion divs so each suggestion is tracked independently
- Move `hiddenForAdoption` assignment inside the null guard to prevent errors when the suggestion div is not found
- Only set `hiddenForAdoption` when the suggestion status is `adopted`, not for other dismiss reasons
