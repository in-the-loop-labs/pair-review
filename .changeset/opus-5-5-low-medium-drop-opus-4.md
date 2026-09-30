---
"@in-the-loop-labs/pair-review": patch
---

Add Opus 5.5 Medium (balanced tier) and Opus 5.5 Low (fast tier) to the Claude provider, and drop the Opus 4.x models. Saved configs that name an Opus 4.x id (e.g. `opus-4.8-xhigh`, `opus-4.6-high`, `opus-4.6-1m`) now resolve to the Opus 5.5 model at the matching effort.

`disabled_models` now matches canonical model ids only. An alias entry (such as `opus`, `fable`, or a retired id like `opus-4.7-high`) is ignored with a warning instead of hiding the model it points to, so a list that hid an old Opus 4.x model no longer hides the Opus 5.5 model that inherited its id. If you disabled a model by alias, list its canonical id instead (e.g. `opus-5.5-xhigh` rather than `opus`).
