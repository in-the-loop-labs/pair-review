---
"@in-the-loop-labs/pair-review": minor
---

Add provider-level `default_model` and `disabled_models` config options. Set `providers.<id>.default_model` to choose a provider's default model (preferred over the now-deprecated per-model `default: true` flag), and `providers.<id>.disabled_models` to hide specific built-in or custom model IDs from the picker.
