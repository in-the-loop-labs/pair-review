---
"@in-the-loop-labs/pair-review": patch
---

Pi and OMP analysis now fails with the model error when the CLI exits successfully but the model returned no text, instead of running an extra LLM extraction call and reporting a generic parse error. A model error that the CLI later retried successfully is no longer reported for an unrelated failure.
