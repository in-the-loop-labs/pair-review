---
"@in-the-loop-labs/pair-review": patch
---

Stop Anthropic models from refusing review prompts with `Refusal (reasoning_extraction)`: the `reasoning` field now asks for concise code evidence and impact instead of step-by-step reasoning. Pi and OMP analysis failures now show the model error message from the CLI output, not only stderr.
